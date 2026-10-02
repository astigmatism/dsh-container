import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
const saved = JSON.parse(await readFile(resolve(process.env.DSH_PROFILE_ROOT, '../../ego-browser/qualification.json')));
const site = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Restored browser fixture</title>'); });
await new Promise((resolve, reject) => { site.once('error', reject); site.listen(saved.port, '127.0.0.1', resolve); });
const base = process.env.DSH_VERIFY_URL;
const login = await fetch(base + '/?token=' + encodeURIComponent(process.env.DSH_BOOT_TOKEN), { redirect: 'manual' });
const cookie = login.headers.getSetCookie().map(row => row.split(';')[0]).join('; ');
async function call(name, args) {
  const response = await fetch(base + '/qualification/ego', { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: saved.sessionId, name, args }), signal: AbortSignal.timeout(60000) });
  const result = await response.json(); assert.equal(response.status, 200, result.error); assert.notEqual(result.value.ok, false, JSON.stringify(result.value)); return result.value;
}
try {
  await call('ego_navigate', { url: `http://127.0.0.1:${saved.port}/restored` });
  const result = await call('ego_js', { expression: "document.cookie.includes('fixtureLogin=shared') && localStorage.getItem('fixtureLogin') === 'shared'" });
  assert.equal(result.result, true, 'website cookies and storage survived graceful shutdown and restored state');
  console.log('Verified website login persistence after Harness restart/state recreation.');
} finally { await new Promise(resolve => site.close(resolve)); }
