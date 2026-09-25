import { setTimeout as delay } from 'node:timers/promises';

export function requireIsolatedVerification(env = process.env) {
  if (env.DSH_VERIFY_ISOLATED !== '1') {
    throw new Error('Mutating verification requires a disposable Harness runtime. Use verify-isolated-runtime.py; never run this probe against production.');
  }
}

export class VerificationFailure extends Error {
  constructor(code, phase) {
    super(`${code}: ${phase}`);
    this.code = code;
  }
}

/** Only inspect events from the current prompt; an earlier reply is not success. */
export function turnOutcome(records, { afterSeq = -1, marker, allowCancellation = false } = {}) {
  const events = records.map(row => row.event).filter(event => event.seq > afterSeq);
  if (events.some(event => event.type === 'tool/start')) return 'unexpected-tool';
  const end = events.filter(event => event.type === 'turn/end').at(-1);
  if (!end) return 'pending';
  if (end.data.reason?.kind === 'aborted') return allowCancellation ? 'complete' : 'verification-cancelled';
  if (end.data.reason?.kind === 'error') return 'provider-failed';
  const matched = events.some(event => event.type === 'assistant/message'
    && event.data.message?.content?.some(block => block.type === 'text' && block.text.trim() === marker));
  return matched ? 'complete' : 'unexpected-reply';
}

export async function waitForVerificationTurn(rpc, sessionId, options) {
  const { phase, timeoutMs = 600000, pollMs = 1000, ...outcomeOptions } = options;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = (await rpc('list')).items.find(item => item.sessionId === sessionId);
    if (!row) throw new VerificationFailure('missing-session', phase);
    if (!row.running && Number.isInteger(row.projections?.asOfSeq)) {
      const history = await rpc('page', { address: { kind: 'session', sessionId },
        throughSeq: row.projections.asOfSeq, maxMessages: 100 });
      const result = turnOutcome(history.records, outcomeOptions);
      if (result === 'complete') return;
      if (result !== 'pending') throw new VerificationFailure(result, phase);
    }
    await delay(pollMs);
  }
  throw new VerificationFailure('verification-timeout', phase);
}

export async function openVerificationSession(page, { workspaceId, workspaceTitle, sessionId, timeoutMs = 30000 }) {
  // Stable identity avoids dependence on a user-editable title and duplicate labels.
  const group = page.locator(`[data-row-key="workspace:${workspaceId}"]`);
  try { await group.waitFor({ state: 'visible', timeout: timeoutMs }); }
  catch { throw new VerificationFailure('missing-workspace', 'waiting for the verification workspace'); }
  const row = page.locator(`[data-row-key="session:${sessionId}"]`);
  const deadline = Date.now() + timeoutMs;
  while (!(await row.isVisible())) {
    if (Date.now() >= deadline) throw new VerificationFailure('missing-session-row', 'opening the verification conversation');
    if (!(await group.count())) throw new VerificationFailure('missing-workspace', 'opening the verification conversation');
    if (await group.getAttribute('aria-expanded', { timeout: 1000 }) === 'false') {
      await group.getByText(workspaceTitle, { exact: true }).click({ timeout: 1000 });
    }
    await delay(100);
  }
  await row.click();
}
