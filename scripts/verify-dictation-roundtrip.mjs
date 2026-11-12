/**
 * Synthetic microphone → HTTPS gateway → Harness → speech service → composer.
 *
 * Dictation is the deployment's required feature, and every hop of it is real
 * here: a Chromium fake microphone device, the authenticated gateway with its
 * login form, a session created over the browser's own RPC surface, the Voice
 * Input plugin's capture row, and the recognizer leg from Harness to an
 * OpenAI-compatible transcription endpoint (the qualification speech service,
 * started by the boot check). The three outcomes a user can meet are all
 * asserted: a transcript that lands in the draft, a service failure that stays
 * in the capture row with a way to retry, and a microphone that cannot produce
 * audio at all. The microphone is also proved to be released afterwards.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { launchVerificationBrowser, verificationSessionRow } from './verification-browser.mjs';

assert.ok(process.env.DSH_BOOT_TOKEN, 'Run only against a disposable boot fixture');
const fixture = process.env.DSH_SPEECH_FIXTURE_URL;
assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(fixture ?? ''), 'DSH_SPEECH_FIXTURE_URL must name the qualification speech service');
const TRANSCRIPT = 'Synthetic microphone round trip succeeded.';
const temporary = await mkdtemp('/tmp/dsh-dictation-roundtrip-');
async function fixtureState(body) {
  const response = body === undefined
    ? await fetch(`${fixture}/__state`)
    : await fetch(`${fixture}/__state`, { method: 'POST', body: JSON.stringify(body) });
  assert.ok(response.ok, `synthetic speech service answered ${response.status}`);
  return await response.json();
}
const transcriptPattern = new RegExp(TRANSCRIPT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
const httpsPort = await freePort(), httpPort = await freePort();
await writeFile(temporary + '/backend-token', process.env.DSH_BOOT_TOKEN, { mode: 0o600 });
await writeFile(temporary + '/stt-key', 'synthetic-speech-key', { mode: 0o600 });
const gateway = spawn(process.execPath, ['/opt/dsh-qualification/gateway/server.mjs'], { env: { ...process.env,
  HARNESS_GATEWAY_DATA_DIR: temporary + '/gateway', HARNESS_BACKEND_URL: process.env.DSH_VERIFY_URL,
  HARNESS_BACKEND_TOKEN_FILE: temporary + '/backend-token', HARNESS_HTTPS_PORT: String(httpsPort),
  HARNESS_HTTP_PORT: String(httpPort), HARNESS_PUBLIC_HTTPS_PORT: String(httpsPort), HARNESS_PUBLIC_HTTP_PORT: String(httpPort),
  HARNESS_AUTH_USERNAME: 'synthetic-user', HARNESS_AUTH_PASSWORD: 'synthetic-dictation-password',
  HARNESS_TLS_MODE: 'auto', HARNESS_TLS_IP: '127.0.0.1', HARNESS_TLS_DNS: 'localhost',
  STT_BASE_URL: `${fixture}/v1`, STT_API_KEY_FILE: temporary + '/stt-key', STT_MAX_RECORD_SECONDS: '5',
}, stdio: ['ignore', 'ignore', 'pipe'] });
let logs = ''; gateway.stderr.on('data', chunk => logs += chunk);
let close, page;
try {
  assert.deepEqual((await fixtureState({ fail: false, reset: true })).received, 0, 'the fixture starts empty');
  const require = createRequire(`${process.env.DSH_PROFILE_ROOT}/package.json`);
  const launched = await launchVerificationBrowser(require('playwright-core').chromium, { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  close = launched.close;
  const context = await launched.browser.newContext({ ignoreHTTPSErrors: true, permissions: ['microphone'] });
  const base = `https://127.0.0.1:${httpsPort}`;
  const deadline = Date.now() + 30000;
  while (true) {
    try { await context.request.get(base); break; } catch {
      assert.ok(gateway.exitCode === null && Date.now() < deadline, `fixture gateway ready: ${logs}`); await delay(200);
    }
  }
  const unauthorized = await context.request.post(base + '/local-stt/transcriptions', { multipart: { file: { name: 'fixture.webm', mimeType: 'audio/webm', buffer: Buffer.from('fixture') } } });
  assert.ok([401, 403].includes(unauthorized.status()));
  page = await context.newPage();
  page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__fixtureTracks = [];
    navigator.mediaDevices.getUserMedia = async options => {
      if (window.__fixtureDenyMicrophone) throw new Error('Synthetic microphone unavailable');
      const stream = await original(options);
      window.__fixtureTracks.push(...stream.getTracks());
      return stream;
    };
    const OriginalRecorder = window.MediaRecorder;
    // Toggled per scenario: a recorder that cannot be constructed must fail the
    // recording without sending any audio, exactly like a device taken by
    // another application.
    window.MediaRecorder = class extends OriginalRecorder {
      constructor() {
        if (window.__fixtureRecorderBroken) throw new Error('Synthetic recorder failure');
        super(...arguments);
      }
    };
  });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('#username').fill('synthetic-user'); await page.locator('#password').fill('synthetic-dictation-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  async function rpc(method, request) {
    const response = await context.request.post(base + '/api/' + method, { data: {
      type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request } },
    } });
    const { result } = await response.json(); assert.equal(result.ok, true, result.error?.message); return result.value;
  }
  const { workspace } = await rpc('workspace/create', { path: temporary });
  const { sessionId } = await rpc('session/create', { workspaceId: workspace.workspaceId });
  await rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue',
    content: [{ type: 'text', text: 'Disposable dictation fixture. Do not use tools.' }] });
  await rpc('session/cancel', { sessionId });
  const title = 'Synthetic dictation verification';
  await rpc('session/rename', { sessionId, title });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const group = page.getByRole('treeitem').filter({ has: page.getByText(workspace.title, { exact: true }) }).first();
  const sessionRow = verificationSessionRow(page, title);
  const navigationDeadline = Date.now() + 30000;
  while (true) {
    assert.ok(Date.now() < navigationDeadline, 'dictation fixture conversation is visible');
    const notice = page.getByRole('dialog', { name: 'Preview Notice' });
    if (await notice.isVisible()) { await notice.getByRole('button', { name: 'Continue', exact: true }).click(); await notice.waitFor({ state: 'hidden' }); }
    const onboarding = page.getByRole('dialog', { name: 'Add an API key to get started' });
    if (await onboarding.isVisible()) await onboarding.getByRole('button', { name: 'Configure later', exact: true }).click();
    try {
      if (await sessionRow.isVisible()) { await sessionRow.click({ timeout: 500 }); break; }
      if (await group.getAttribute('aria-expanded') === 'false') await group.getByText(workspace.title, { exact: true }).click({ timeout: 500 });
    } catch (error) { if (error.name !== 'TimeoutError') throw error; }
    await delay(100);
  }

  const microphone = page.locator('[data-composer-card] button[aria-label="Start recording"]').first();
  const composer = page.locator('[data-composer-input][contenteditable="true"]').first();
  const row = page.locator('[data-voice-activity]').first();
  await microphone.waitFor(); await composer.fill('');
  // Exactly one microphone in the composer, and never the retired one: enabling
  // both speech bundles at once is the failure mode this substitution created.
  assert.equal(await page.locator(
    '[data-composer-card] button[aria-label="Start recording"], [data-composer-card] button[aria-label="Open voice input setup"]',
  ).count(), 1, 'the composer must carry exactly one microphone control');
  assert.equal(await page.locator('[data-local-speech-button]').count(), 0, 'the retired microphone is still mounted');

  /** Start a recording, prove the waveform is live, and stop it again. */
  async function record() {
    await microphone.click();
    await page.waitForSelector('[data-voice-activity="recording"]', { timeout: 15000 });
    // A waveform that never leaves its resting bars measures nothing; the fake
    // device emits a tone, so at least one bar has to move off the baseline.
    const moved = () => {
      const svg = document.querySelector('[data-voice-activity="recording"] svg[role="img"]');
      return svg !== null && [...svg.querySelectorAll('line')]
        .some(line => line.getAttribute('y1') !== '19' || line.getAttribute('y2') !== '21');
    };
    await page.waitForFunction(moved, null, { timeout: 10000 })
      .catch(() => { throw new Error('the capture waveform did not measure the synthetic microphone'); });
    await delay(400);
    await page.click('[data-voice-activity="recording"] button[aria-label="Stop and transcribe"]');
  }

  // 1. A working service puts the transcript in the draft.
  await record();
  await page.waitForFunction(
    text => (document.querySelector('[data-composer-input][contenteditable="true"]')?.textContent ?? '').includes(text),
    TRANSCRIPT,
    { timeout: 30000 },
  );
  assert.equal((await fixtureState()).received, 1, 'one recording reached the speech service');
  assert.match(await composer.textContent(), transcriptPattern);

  // 2. A service failure stays visible with a retry, and changes no text.
  await fixtureState({ fail: true });
  const before = await composer.textContent();
  await record();
  await page.waitForSelector('[data-voice-activity="feedback"]', { timeout: 30000 });
  const reported = await row.textContent();
  assert.match(reported, /Speech recognition failed/);
  assert.match(reported, /Synthetic STT unavailable/);
  assert.equal(await composer.textContent(), before, 'a failed recording inserts nothing');
  assert.equal(await page.locator('[data-voice-activity="feedback"] button[aria-label="Record again"]').count(), 1,
    'a failed recording must offer to record again');

  // 3. A microphone that yields no audio fails without sending anything.
  await page.evaluate(() => { window.__fixtureRecorderBroken = true; });
  await page.click('[data-voice-activity="feedback"] button[aria-label="Record again"]');
  const brokenReported = await page.waitForFunction(() => document.querySelector('[data-voice-activity="feedback"], [data-voice-activity="error"]')?.textContent?.includes('Synthetic recorder failure') === true, null, { timeout: 15000 })
    .then(() => true).catch(() => false);
  if (!brokenReported) throw new Error(`a broken recorder reported nothing visible: ${await row.textContent()}`);
  const state = await fixtureState();
  assert.equal(state.received, 1, 'a broken recorder sends no audio');
  assert.equal(state.rejected, 1, 'only the unavailable service was rejected');
  assert.ok(state.lastBytes > 500, `real microphone audio expected, saw ${state.lastBytes} bytes`);
  assert.equal(state.lastModel, 'synthetic-whisper', 'the recognizer must send the configured model');
  assert.equal(state.lastLanguage, '', 'automatic language detection sends no language field');
  assert.equal(state.lastAuthorized, true, 'the mounted key must authorize the request');

  // The capture is owned by the recording, never left running after it ends.
  await page.waitForFunction(() => window.__fixtureTracks.length > 0
    && window.__fixtureTracks.every(track => track.readyState === 'ended'), null, { timeout: 15000 });
  await page.evaluate(() => { window.__fixtureRecorderBroken = false; });
  assert.match(await composer.textContent(), new RegExp(TRANSCRIPT.replace(/[*+?^${}()|[\]\\]/g, '\\$&')));
  console.log('Verified synthetic microphone capture through the authenticated HTTPS gateway and the recognizer leg: transcript inserted, service failure shown with a retry, a broken recorder refused without sending audio, and every microphone track released.');
} catch (error) {
  console.error(String(error?.stack ?? error).split(process.env.DSH_BOOT_TOKEN).join('<redacted>'));
  console.error((await page?.locator('body').innerText().catch(() => '') ?? '').slice(-3500));
  process.exitCode = 1;
} finally {
  await close?.(); gateway.kill('SIGTERM');
  await Promise.race([new Promise(resolve => gateway.once('exit', resolve)), delay(5000)]);
  if (gateway.exitCode === null) gateway.kill('SIGKILL');
  await rm(temporary, { recursive: true, force: true });
}
