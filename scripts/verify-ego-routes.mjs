#!/usr/bin/env node
/** Non-mutating browser transport gate, also used by Service Portal. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const base = process.env.DSH_VERIFY_URL || `http://127.0.0.1:${process.env.DSH_WEB_PORT || 3080}`;
const secret = process.env.DSH_BOOT_TOKEN || (await readFile(process.env.DSH_WEB_LAUNCH_TOKEN_FILE || '/run/dsh-backend-auth/launch-token', 'utf8')).trim();
const authenticated = await fetch(`${base}/?token=${encodeURIComponent(secret)}`, { redirect: 'manual' });
const cookie = authenticated.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
assert.ok(cookie, 'Harness issued its authenticated cookie');
for (const route of ['/api/ego/spaces', '/api/ego/input', '/api/ego/stream', '/ego/api/get', '/ego/api/set']) {
  for (const headers of [{}, { cookie: 'dsh-auth-forged=fixture' }, { cookie, origin: 'http://untrusted.invalid' }]) {
    const response = await fetch(base + route, { method: route.includes('/ego/api/') || route.endsWith('/input') ? 'POST' : 'GET', headers, signal: AbortSignal.timeout(10000) });
    assert.ok([401, 403].includes(response.status), `${route}: rejected unauthorized/cross-origin request (${response.status})`);
    await response.body?.cancel();
  }
}
const response = await fetch(`${base}/api/ego/spaces`, { headers: { cookie }, signal: AbortSignal.timeout(20000) });
assert.equal(response.status, 200);
assert.deepEqual((await response.json()).spaces, [], 'unscoped clients cannot select a conversation tab');
const settings = await fetch(`${base}/ego/api/get`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) });
assert.equal(settings.status, 200);
assert.ok((await settings.json()).ok, 'authenticated ego settings route');
console.log('Verified authenticated ego control, settings and stream routes; forged cookies and foreign origins are rejected.');
