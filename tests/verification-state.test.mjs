import assert from 'node:assert/strict';
import test from 'node:test';
import { requireIsolatedVerification, turnOutcome, waitForVerificationTurn,
  openVerificationSession } from '../scripts/verification-state.mjs';

const event = (seq, type, data) => ({ type: 'event', event: { seq, type, data } });
const reply = seq => event(seq, 'assistant/message', { message: { content: [{ type: 'text', text: 'READY' }] } });
const end = (seq, kind) => event(seq, 'turn/end', { reason: { kind } });

test('production is refused before a browser or conversation is created', () => {
  for (const env of [{}, { DSH_VERIFY_ISOLATED: 'true' }, { DSH_VERIFY_ISOLATED: '0' }]) {
    assert.throws(() => requireIsolatedVerification(env), /disposable Harness/);
  }
  requireIsolatedVerification({ DSH_VERIFY_ISOLATED: '1' });
});

test('an idle, user-cancelled initial prompt is a cancellation, never successful readiness', async () => {
  const rpc = async name => name === 'list'
    ? { items: [{ sessionId: 'fixture', running: false, projections: { asOfSeq: 16 } }] }
    : { records: [event(8, 'user/message', {}), end(16, 'aborted')] };
  await assert.rejects(waitForVerificationTurn(rpc, 'fixture', { marker: 'READY', phase: 'initial READY' }),
    { code: 'verification-cancelled' });
});

test('missing sessions fail immediately, and provider errors have their own outcome', async () => {
  await assert.rejects(waitForVerificationTurn(async () => ({ items: [] }), 'missing', { phase: 'initial' }),
    { code: 'missing-session' });
  assert.equal(turnOutcome([end(3, 'error')], { marker: 'READY' }), 'provider-failed');
  assert.equal(turnOutcome([end(3, 'aborted')], { allowCancellation: true }), 'complete');
});

test('inference requires a completed current reply and forbids tools', () => {
  assert.equal(turnOutcome([reply(2)], { marker: 'READY' }), 'pending');
  assert.equal(turnOutcome([reply(2), end(3, 'completed')], { marker: 'READY' }), 'complete');
  assert.equal(turnOutcome([reply(2), end(3, 'completed'), end(8, 'completed')],
    { marker: 'READY', afterSeq: 3 }), 'unexpected-reply');
  assert.equal(turnOutcome([event(1, 'tool/start', {}), reply(2), end(3, 'completed')],
    { marker: 'READY' }), 'unexpected-tool');
});

test('missing workspace reports its cause without trying a second awaited locator', async () => {
  let attributeReads = 0;
  const page = { locator: () => ({ waitFor: async () => { throw new Error('timeout'); },
    getAttribute: async () => { attributeReads++; throw new Error('masked original cause'); } }) };
  await assert.rejects(openVerificationSession(page, { workspaceId: 'w', sessionId: 's', timeoutMs: 1 }),
    { code: 'missing-workspace' });
  assert.equal(attributeReads, 0);
});

test('pending work has a bounded, classified timeout', async () => {
  await assert.rejects(waitForVerificationTurn(async () => ({ items: [{ sessionId: 's', running: true }] }),
    's', { phase: 'inference', timeoutMs: 2, pollMs: 1 }), { code: 'verification-timeout' });
});
