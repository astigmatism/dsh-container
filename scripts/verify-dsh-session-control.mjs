// Explicit live smoke test: creates one isolated Harness session, pauses it,
// then checks that a fresh prompt in that same session completes. Never resumes
// an existing task. Run inside the deployed Harness with --live.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

if (!process.argv.includes('--live')) throw new Error('Pass --live to create a smoke-test session and use the model.');
const base = 'http://127.0.0.1:3080';
const token = (await readFile('/run/dsh-backend-auth/launch-token', 'utf8')).trim();
const auth = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
assert.equal(auth.status, 303);
const cookie = auth.headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie);
async function rpc(name, request) {
  const method = `session/${name}`;
  const response = await fetch(`${base}/api/${method}`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: name === 'list' ? { _request: request } : { request } } }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, `${name}: HTTP ${response.status}`);
  const { result } = await response.json();
  assert.equal(result.ok, true, `${name}: ${result.error?.code}: ${result.error?.message}`);
  return result.value;
}
const { sessionId } = await rpc('create', { cwd: '/tmp' });
console.log(`Smoke-test session: ${sessionId}`);
async function row() {
  const list = await rpc('list', {});
  const item = list.items.find(item => item.sessionId === sessionId);
  assert.ok(item, 'smoke-test session remains available');
  return item;
}
async function waitFor(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const item = await row();
    if (predicate(item)) return item;
    await delay(500);
  }
  throw new Error('Session control state did not converge before the smoke-test deadline');
}
async function prompt(text) {
  await rpc('prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] });
}
try {
  await rpc('rename', { sessionId, title: 'Harness deployment verification — cancellation and recovery' });
  await rpc('selectModel', { sessionId, provider: 'local-ollama', model: 'local-active', reasoningEffort: 'off' });
  await prompt('This is a text-only cancellation smoke test. Do not use any tools or access files. Print the integers from 1 to 10000, one per line, until interrupted.');
  await waitFor(item => item.running);
  await delay(2000);
  const started = Date.now();
  await rpc('cancel', { sessionId });
  await waitFor(item => !item.running);
  console.log(`Stop reached idle in ${Date.now() - started}ms.`);
  await prompt('The interruption was intentional. This is a text-only recovery smoke test. Do not use tools or access files. Reply with exactly HARNESS_RECOVERY_OK and no other text.');
  let events = [];
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const item = await row();
    const throughSeq = item.projections?.asOfSeq;
    if (!item.running && Number.isInteger(throughSeq)) {
      const page = await rpc('page', { address: { kind: 'session', sessionId }, throughSeq, maxMessages: 50 });
      events = page.records.map(record => record.event);
      if (events.some(event => event.type === 'assistant/message' && event.data.message?.content?.some(block => block.type === 'text' && block.text.includes('HARNESS_RECOVERY_OK')))) break;
    }
    await delay(1000);
  }
  assert.ok(events.some(event => event.type === 'turn/end' && event.data.reason?.kind === 'aborted'), 'cancellation persisted');
  assert.ok(events.some(event => event.type === 'assistant/message' && event.data.message?.content?.some(block => block.type === 'text' && block.text.includes('HARNESS_RECOVERY_OK'))), 'same-session recovery reply persisted');
  assert.ok(!events.some(event => event.type === 'tool/start'), 'smoke test did not execute tools');
  console.log('Live Harness API: durable cancellation and same-session model recovery passed.');
} finally {
  await rpc('cancel', { sessionId });
}
