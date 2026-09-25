import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const token = (await readFile('/run/dsh-backend-auth/launch-token', 'utf8')).trim();
const base = 'http://127.0.0.1:3080';
const auth = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
const cookie = auth.headers.get('set-cookie').split(';')[0];
async function rpc(method, request = {}) {
  const response = await fetch(`${base}/api/${method}`, { method: 'POST',
    headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({
      type: 'client-request', rpcId: randomUUID(), method,
      payload: { args: method === 'session/list' ? { _request: request } : { request } },
    }) });
  const { result } = await response.json();
  if (!result.ok) throw Error(`${method}: ${JSON.stringify(result.error)}`);
  return result.value;
}
if (process.argv.includes('--populate')) {
  const { workspace } = await rpc('workspace/create', { path: '/tmp' });
  const { sessionId } = await rpc('session/create', { workspaceId: workspace.workspaceId });
  await rpc('session/rename', { sessionId, title: 'Existing user conversation' });
  await rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue',
    content: [{ type: 'text', text: 'Reply with READY.' }] });
  for (let i = 0; i < 120; i++) {
    const row = (await rpc('session/list')).items.find(row => row.sessionId === sessionId);
    if (!row.running && !row.blank) break;
    if (i === 119) throw Error('User fixture failed to finish');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
if (process.argv.includes('--cancel-verification')) {
  const row = (await rpc('session/list')).items.find(row => row.running && row.cwd?.includes('dsh-resident-verification-'));
  if (!row) process.exit(3);
  await rpc('session/cancel', { sessionId: row.sessionId });
}
if (process.argv.includes('--remove-verification-workspace')) {
  const row = (await rpc('session/list')).items.find(row => row.running && row.cwd?.includes('dsh-resident-verification-'));
  if (!row) process.exit(3);
  const { workspace } = await rpc('workspace/create', { path: row.cwd });
  await rpc('workspace/delete', { workspaceId: workspace.workspaceId });
}
if (process.argv.includes('--cancel-archive')) {
  for (const { sessionId, running } of (await rpc('session/list')).items) {
    if (running) await rpc('session/cancel', { sessionId });
    await rpc('workspace/archiveSession', { sessionId });
  }
}
console.log(JSON.stringify((await rpc('session/list')).items.map(row => ({
  sessionId: row.sessionId, title: row.title, cwd: row.cwd, blank: row.blank,
})).sort((a, b) => a.sessionId.localeCompare(b.sessionId))));
