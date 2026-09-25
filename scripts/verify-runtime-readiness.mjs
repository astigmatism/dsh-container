/** Read-only application RPC checks. Do not open a browser: startup creates drafts. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readSettings, residentClientExpectations } from './verify-router-contract.mjs';

const token = (await readFile(process.env.DSH_WEB_LAUNCH_TOKEN_FILE
  ?? '/run/dsh-backend-auth/launch-token', 'utf8')).trim();
const base = 'http://127.0.0.1:3080';
const auth = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
assert.equal(auth.status, 303, 'production authentication');
const cookie = auth.headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie, 'production authentication cookie');
async function read(method) {
  assert.ok(['pluginInventory/list', 'session/modelCatalog'].includes(method));
  const response = await fetch(`${base}/api/${method}`, { method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: {} } }),
    signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, method);
  const { result } = await response.json();
  assert.equal(result.ok, true, `${method} failed`);
  return result.value;
}
const inventory = await read('pluginInventory/list');
const maintained = new Set(['dsh-context', 'dsh-favicon-status', 'dsh-local-speech-input',
  'dsh-loop-detector', 'dsh-playwright', 'dsh-plugin-task-notification',
  'dsh-session-pin', 'dsh-ui-appearance', 'dsh-better-sidebar']);
for (const row of inventory.entries) {
  if (row.enabled && (maintained.has(row.moduleName) || /dsh-(web-search-free|router-model-discovery)\.js$/.test(row.moduleName ?? ''))) {
    assert.equal(row.fiberPhase, 'active', `${row.moduleName} is not active`);
  }
}
for (const preset of inventory.agentPresets) assert.equal(preset.broken, undefined, 'broken agent preset');
const expected = await residentClientExpectations(await readSettings('/data/dsh/settings.yaml'));
const catalog = await read('session/modelCatalog');
assert.deepEqual(catalog.failures, []);
assert.deepEqual(catalog.groups.flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id, name: model.name }))),
  expected.map(({ provider, model, name }) => ({ provider, model, name })));
console.log('Production plugin inventory and model catalog passed without creating a conversation.');
