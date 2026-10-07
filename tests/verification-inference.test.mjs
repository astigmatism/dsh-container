import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationPrompt, meterTokens } from '../scripts/verification-inference.mjs';

const error = (status, code) => ({ kind: 'error', error: { code: 'SERVER',
  message: `local-ollama API error (${status}): ${JSON.stringify({ code })}` } });
const completed = { kind: 'completed' };
function fixture(attempts, previous = []) {
  let time = 0, calls = 0;
  const records = previous.map(event => ({ event }));
  const sent = [];
  const rpc = async (name, request) => {
    if (name === 'list') return { items: [{ sessionId: 'isolated', running: false,
      projections: { asOfSeq: records.at(-1)?.event.seq ?? 0 } }] };
    if (name === 'page') return { records };
    assert.equal(name, 'prompt', 'verification cannot switch a model or touch user settings');
    assert.equal(request.sessionId, 'isolated');
    sent.push(request);
    const attempt = attempts[Math.min(calls++, attempts.length - 1)];
    const append = (type, data) => records.push({ event: { seq: (records.at(-1)?.event.seq ?? 0) + 1, type, data } });
    if (attempt.tool) append('tool/start', {});
    if (attempt.text) append('assistant/message', { message: { content: [{ type: 'text', text: attempt.text }] } });
    if (attempt.reason) append('turn/end', { reason: attempt.reason });
    return {};
  };
  return { sent, elapsed: () => time, run: () => verificationPrompt({ rpc, sessionId: 'isolated', text: 'Reply with OK',
    expectedText: 'OK', timeoutMs: 15000, drainTimeoutMs: 11000, pollMs: 1000,
    now: () => time, sleep: async ms => { time += ms; } }) };
}

test('temporary backend draining retries only the isolated prompt with fresh request IDs', async () => {
  const f = fixture([{ reason: error(503, 'BACKEND_DRAINING') }, { reason: completed, text: 'OK' }]);
  await f.run();
  assert.equal(f.sent.length, 2);
  assert.notEqual(f.sent[0].requestId, f.sent[1].requestId);
  assert.equal(f.elapsed(), 5000);
});

for (const [status, code] of [[503, 'UNHEALTHY'], [401, 'UNAUTHORIZED'], [400, 'BACKEND_DRAINING']]) {
  test(`HTTP ${status} ${code} fails immediately without replay`, async () => {
    const f = fixture([{ reason: error(status, code) }]);
    await assert.rejects(f.run(), /ended without completion/);
    assert.equal(f.sent.length, 1);
    assert.equal(f.elapsed(), 0);
  });
}

test('persistent draining has a bounded retry window', async () => {
  const f = fixture([{ reason: error(503, 'BACKEND_DRAINING') }]);
  await assert.rejects(f.run(), /BACKEND_DRAINING persisted/);
  assert.equal(f.sent.length, 3);
  assert.equal(f.elapsed(), 11000);
});

test('prior successful replies do not mask a failed new request', async () => {
  const f = fixture([{ reason: completed, text: 'WRONG' }], [
    { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'OK' }] } } },
    { seq: 2, type: 'turn/end', data: { reason: completed } },
  ]);
  await assert.rejects(f.run(), /without its expected reply/);
  assert.equal(f.elapsed(), 0);
});

test('partial output followed by draining is never replayed', async () => {
  const f = fixture([{ reason: error(503, 'BACKEND_DRAINING'), text: 'partial output' }]);
  await assert.rejects(f.run(), /ended without completion/);
  assert.equal(f.sent.length, 1);
});

test('tool execution cannot pass acceptance or trigger a retry', async () => {
  const f = fixture([{ reason: error(503, 'BACKEND_DRAINING'), tool: true }]);
  await assert.rejects(f.run(), /text-only/);
  assert.equal(f.sent.length, 1);
});

test('an unfinished request is bounded and never duplicated', async () => {
  const f = fixture([{}]);
  await assert.rejects(f.run(), /deadline/);
  assert.equal(f.sent.length, 1);
  assert.equal(f.elapsed(), 15000);
});

test('context meter capacity follows the Harness compact token format for every router window', () => {
  // Nighttime at 96K (98304 less the 1024 reserve) renders 97.3K, not 97K.
  assert.equal(meterTokens(98304 - 1024), '97.3K');
  assert.equal(meterTokens(98304), '98.3K');
  assert.equal(meterTokens(163840 - 1024), '163K');
  assert.equal(meterTokens(131072), '131K');
  assert.equal(meterTokens(65536), '65.5K');
  assert.equal(meterTokens(32000), '32K');
  assert.equal(meterTokens(999), '999');
});
