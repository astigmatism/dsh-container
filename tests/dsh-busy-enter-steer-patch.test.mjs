import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { isPatched, marker, patchSource } from '../scripts/patch-dsh-busy-enter-steer.mjs';

// Verbatim excerpt of @deepseek-ai/dsh-client-ui-conversation@0.2.0-rc.2
// lib/client.js: the busy-Enter settings vocabulary, resolveSubmitMode, and
// ComposerSubmissionPolicy (MIT; license alongside).
const fixture = await readFile(new URL('./fixtures/dsh-client-ui-conversation-busy-enter-0.2.0-rc.2.js', import.meta.url), 'utf8');

function load(source) {
  const stubs = `
const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain });
const Schema = chain;
const _deepseek_ai_dsh_client_store = {
  createSnapshotStore(initial) {
    let value = initial;
    const listeners = new Set();
    return {
      getSnapshot: () => value,
      set(next) { value = next; for (const listener of listeners) listener(); },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    };
  },
};
`;
  // eslint-disable-next-line no-new-func
  return new Function(`${stubs}${source}\nreturn { resolveSubmitMode, ComposerSubmissionPolicy, DEFAULT_BUSY_ENTER_BEHAVIOR };`)();
}

function hostForm(value) {
  const writes = [];
  return {
    writes,
    getSnapshot: () => ({ value }),
    subscribe: () => () => {},
    set: (field, next) => { writes.push([field, next]); return Promise.resolve(true); },
  };
}

test('busy Enter steers by default on pages without Host settings', () => {
  const { resolveSubmitMode, ComposerSubmissionPolicy, DEFAULT_BUSY_ENTER_BEHAVIOR } = load(patchSource(fixture));
  assert.equal(DEFAULT_BUSY_ENTER_BEHAVIOR, 'steer');
  const policy = new ComposerSubmissionPolicy(undefined);
  assert.equal(policy.busyEnter.getSnapshot(), 'steer');
  const preferred = policy.busyEnter.getSnapshot();
  assert.equal(resolveSubmitMode(preferred, true, 'enter', true), 'steer');
  // Cmd/Ctrl+Enter keeps queueing one chord away.
  assert.equal(resolveSubmitMode(preferred, true, 'accelerated', true), 'queue');
  // Idle sessions and transports without steering still send normally.
  assert.equal(resolveSubmitMode(preferred, false, 'enter', true), 'queue');
  assert.equal(resolveSubmitMode(preferred, true, 'enter', false), 'queue');
});

test('an explicit Host choice still wins over the steer default', () => {
  const { ComposerSubmissionPolicy } = load(patchSource(fixture));
  const form = hostForm({ busyEnter: 'queue' });
  const policy = new ComposerSubmissionPolicy(form);
  assert.equal(policy.busyEnter.getSnapshot(), 'queue');
  assert.deepEqual(form.writes, [], 'adopting the Host value must not write it back');
  policy.setBusyEnter('steer');
  assert.deepEqual(form.writes, [['busyEnter', 'steer']]);
});

test('the unpatched pinned bundle queues by default', () => {
  const { ComposerSubmissionPolicy } = load(fixture);
  assert.equal(new ComposerSubmissionPolicy(undefined).busyEnter.getSnapshot(), 'queue');
});

test('busy-Enter patch is idempotent and fails closed on drift', () => {
  const once = patchSource(fixture);
  assert.ok(once.includes(marker));
  assert.ok(isPatched(once));
  assert.equal(isPatched(fixture), false);
  assert.equal(patchSource(once), once);
  assert.throws(() => patchSource('different upstream'), /source drift/);
  assert.throws(() => patchSource(fixture.replace('["queue", "steer"]', '["queue", "steer", "interrupt"]')), /source drift/);
});

test('the repository profile also selects steer for Host-backed pages', async () => {
  const profile = await readFile(new URL('../seed/profile/managed/cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(profile, /^- id: ui-conversation\n {2}config:\n {4}busyEnter: steer$/m);
});
