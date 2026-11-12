import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  isPatched,
  marker,
  patchSource,
  retryHelper,
  verifyPreviewUntouched,
} from '../scripts/patch-dsh-voice-background.mjs';

// Verbatim excerpt of @deepseek-ai/dsh-experimental-client-ui-voice-input
// 0.2.2-rc.1 lib/client.js (MIT; license alongside).
const fixture = await readFile(
  new URL('./fixtures/dsh-experimental-client-ui-voice-input-background-0.2.2-rc.1.js', import.meta.url),
  'utf8',
);

/** Build the injected retry helper out of the exact text the patch injects. */
function loadHelper() {
  // eslint-disable-next-line no-new-func
  return new Function(`${retryHelper}\nreturn transcribeWithRetry;`)();
}

const ok = text => ({ ok: true, value: { text } });
const fail = message => ({ ok: false, error: new Error(message) });

async function transcribeWithRetry(...args) {
  return loadHelper()(...args);
}

test('a live recording is no longer discarded when the page loses focus', () => {
  const patched = patchSource(fixture);
  assert.ok(patched.includes(marker));
  // The two listeners that threw the take away are gone, registration included.
  assert.doesNotMatch(patched, /const blur = \(\) => \{/);
  assert.doesNotMatch(patched, /const visibility = \(\) => \{/);
  assert.doesNotMatch(patched, /addEventListener\("blur"/);
  assert.doesNotMatch(patched, /addEventListener\("visibilitychange", visibility\)/);
  // Escape still cancels, and leaving the page mid-take warns instead of losing it.
  assert.ok(patched.includes('window.addEventListener("beforeunload", warn);'));
  assert.ok(patched.includes('window.removeEventListener("beforeunload", warn);'));
  assert.ok(patched.includes('document.addEventListener("keydown", escape);'));
  assert.ok(patched.includes('if (current.current?.phase === "recording") event.preventDefault();'));
});

test('the take is re-sent instead of being recorded again after a failure', () => {
  const patched = patchSource(fixture);
  // One call site, now routed through the retry helper, still passing the same audio.
  assert.equal(patched.match(/await transcribeWithRetry\(transcribe, \{/g)?.length, 1);
  assert.doesNotMatch(patched, /const result = await transcribe\(\{/);
  assert.ok(patched.includes('audioBase64: audioBase64(audio),'));
  assert.ok(patched.includes('async function transcribeWithRetry('));
});

test('the patch is idempotent and fails closed on upstream drift', () => {
  const once = patchSource(fixture);
  assert.equal(isPatched(fixture), false);
  assert.equal(isPatched(once), true);
  assert.equal(patchSource(once), once);
  assert.throws(() => patchSource('different upstream'), /source drift/);
  // A release that moves the visibility cancellation into the blur handler is a
  // shape this patch cannot assert anything about, so it has to fail the build.
  const moved = fixture.replace(/const blur = \(\) => \{\n\t+if \(current\.current\?\.phase === "recording"\) cancel\(\);\n\t+\};/, '');
  assert.throws(() => patchSource(moved), /source drift/);
  const renamed = fixture.replace('const result = await transcribe({', 'const result = await speech.transcribe({');
  assert.throws(() => patchSource(renamed), /source drift/);
  const lostCleanup = fixture.replace('\t\t\t\t\twindow.removeEventListener("blur", blur);\n\t\t\t\t\tdocument.removeEventListener("visibilitychange", visibility);\n', '');
  assert.throws(() => patchSource(lostCleanup), /source drift/);
});

test('the settings device preview keeps releasing its preview microphone', () => {
  verifyPreviewUntouched(patchSource(fixture));
  const stripped = fixture.replace('\t\t\t\tconst hidden = () => {\n\t\t\t\t\tif (document.hidden) {', '\t\t\t\tconst hidden = () => {');
  assert.throws(() => verifyPreviewUntouched(stripped), /visibility handler moved/);
});

test('recognition succeeds on the first attempt without retrying', async () => {
  const calls = [];
  const controller = new AbortController();
  const result = await transcribeWithRetry(
    async payload => { calls.push(payload); return ok('hello'); },
    { audioBase64: 'a' },
    controller.signal,
    [1, 1],
  );
  assert.deepEqual(result, ok('hello'));
  assert.equal(calls.length, 1);
});

test('a cold recognizer or dropped remote costs nothing', async () => {
  const calls = [];
  const controller = new AbortController();
  const result = await transcribeWithRetry(
    async () => {
      calls.push(Date.now());
      return calls.length === 1 ? fail('503 from the voice host') : ok('recovered');
    },
    { audioBase64: 'a' },
    controller.signal,
    [5, 5],
  );
  assert.deepEqual(result, ok('recovered'));
  assert.equal(calls.length, 2, 'the same take has to be re-sent, not re-recorded');
});

test('a transport throw is retried and reported as the last failure', async () => {
  const attempts = [];
  const controller = new AbortController();
  const result = await transcribeWithRetry(
    async () => {
      attempts.push('throw');
      throw new TypeError('speech remote is not connected');
    },
    { audioBase64: 'a' },
    controller.signal,
    [1, 1],
  );
  assert.equal(attempts.length, 3, 'two backoffs, then give up');
  assert.equal(result.ok, false);
  assert.match(result.error.message, /speech remote is not connected/);
});

test('an empty recording is reported, not retried', async () => {
  let calls = 0;
  const controller = new AbortController();
  const result = await transcribeWithRetry(
    async () => { calls += 1; return ok(''); },
    { audioBase64: 'a' },
    controller.signal,
    [1, 1],
  );
  assert.equal(calls, 1);
  assert.deepEqual(result, ok(''));
});

test('cancelling mid-recording stops retrying at once', async () => {
  const controller = new AbortController();
  // The user hits the ✕ button while the helper is waiting out a backoff.
  setTimeout(() => controller.abort(), 20);
  let calls = 0;
  const started = Date.now();
  const result = await transcribeWithRetry(
    async () => { calls += 1; return fail('voice host asleep'); },
    { audioBase64: 'a' },
    controller.signal,
    [10_000, 10_000],
  );
  assert.ok(Date.now() - started < 5_000, 'the abort has to cut the backoff short');
  assert.equal(calls, 1);
  assert.equal(result.ok, false, 'the caller discards this through its generation check');
});

test('the pinned upstream version is what the anchors were read from', async () => {
  const license = await readFile(
    new URL('./fixtures/dsh-experimental-client-ui-voice-input-LICENSE', import.meta.url),
    'utf8',
  );
  assert.match(license, /MIT License/);
  assert.match(fixture, /async function disposeRecording\(capture\) \{/);
});
