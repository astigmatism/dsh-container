import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/** The context meter's compact count (dsh-client-ui-conversation formatTokens):
 * decimal K, whole from 100K and one decimal below, so 162816 is 163K and
 * 97280 is 97.3K. Router context windows change with each configuration.
 */
export function meterTokens(value) {
  const scaled = candidate => candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10);
  if (value < 1e3) return String(value);
  return value < 1e6 ? `${scaled(value / 1e3)}K` : `${scaled(value / 1e6)}M`;
}

function draining(reason) {
  if (reason?.kind !== 'error') return false;
  // The patched adapter classifies BACKEND_DRAINING/MAINTENANCE_MODE as
  // ROUTER_SWITCHING (docs/llm-router-contract.md §7, §10).
  if (reason.error?.code === 'ROUTER_SWITCHING') return true;
  const match = / API error \(503\): (\{.*\})$/.exec(reason.error?.message ?? '');
  if (!match) return false;
  try { return ['BACKEND_DRAINING', 'MAINTENANCE_MODE'].includes(JSON.parse(match[1]).code); }
  catch { return false; }
}

/** Retry only an isolated acceptance prompt rejected before any model output.
 * Never used by user sessions, and never changes the selected provider/model.
 */
export async function verificationPrompt({ rpc, sessionId, text, expectedText,
  timeoutMs = 600000, drainTimeoutMs = 120000, pollMs = 1000,
  now = Date.now, sleep = delay }) {
  const deadline = now() + timeoutMs;
  let drainDeadline;
  const row = async () => {
    const item = (await rpc('list')).items.find(item => item.sessionId === sessionId);
    assert.ok(item, 'verification session exists');
    return item;
  };
  while (now() < deadline) {
    const baseline = (await row()).projections?.asOfSeq ?? -1;
    await rpc('prompt', { sessionId, requestId: randomUUID(), mode: 'queue',
      content: [{ type: 'text', text }] });
    while (now() < deadline) {
      const item = await row();
      const throughSeq = item.projections?.asOfSeq;
      if (!item.running && Number.isInteger(throughSeq) && throughSeq > baseline) {
        const history = await rpc('page', { address: { kind: 'session', sessionId }, throughSeq, maxMessages: 50 });
        const events = history.records.map(record => record.event).filter(event => event.seq > baseline);
        assert.ok(!events.some(event => event.type === 'tool/start'), 'acceptance must remain text-only');
        const end = events.findLast(event => event.type === 'turn/end');
        if (end) {
          const messages = events.filter(event => event.type === 'assistant/message');
          if (draining(end.data.reason) && messages.length === 0) {
            drainDeadline ??= Math.min(deadline, now() + drainTimeoutMs);
            assert.ok(now() < drainDeadline, 'Verification blocked: router BACKEND_DRAINING persisted beyond the retry window');
            await sleep(Math.min(5000, drainDeadline - now()));
            assert.ok(now() < drainDeadline, 'Verification blocked: router BACKEND_DRAINING persisted beyond the retry window');
            break;
          }
          const code = end.data.reason?.error?.code;
          const safeCode = typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code) ? code : 'unknown';
          assert.equal(end.data.reason?.kind, 'completed', `Verification request ended without completion (${safeCode})`);
          assert.ok(messages.some(event => event.data.message?.content?.some(block => block.type === 'text'
            && (expectedText === undefined ? block.text.trim().length > 0 : block.text.trim() === expectedText))),
          'Verification request completed without its expected reply');
          return;
        }
      }
      await sleep(pollMs);
    }
  }
  assert.fail('Verification request did not finish before its deadline');
}
