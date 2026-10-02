/** CI-only real-client regression for first launch after a Harness upgrade. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { launchVerificationBrowser } from './verification-browser.mjs';

const profile = process.env.DSH_PROFILE_ROOT;
assert.match(profile ?? '', /\/dsh-plugin-boot\.[^/]+\//, 'Only disposable plugin-boot fixtures may alter notice settings');
const base = process.env.DSH_VERIFY_URL;
const secret = process.env.DSH_BOOT_TOKEN;
assert.ok(base && secret);
const require = createRequire(`${profile}/package.json`);
const { browser, close } = await launchVerificationBrowser(require('playwright-core').chromium);
const context = await browser.newContext();
async function settings(method, args = {}) {
  const response = await context.request.post(`${base}/api/settings/${method}`, { data: {
    type: 'client-request', rpcId: randomUUID(), method: `settings/${method}`, payload: { args },
  } });
  assert.equal(response.status(), 200);
  const body = await response.json();
  assert.equal(body.result?.ok, true);
  return body.result.value;
}
const view = async () => (await settings('describe')).namespaces.find(row => row.ns === 'ui-settings-general');
const mutate = ops => settings('mutate', { ns: 'ui-settings-general', ops });
let original;
const field = 'welcomeNoticeVersion';
try {
  await context.request.get(`${base}/?token=${encodeURIComponent(secret)}`);
  original = await view();
  assert.ok(original, 'fixture welcome settings namespace is registered');
  for (const previous of ['2026-08-13.1', undefined]) {
    await mutate([{ op: previous === undefined ? 'unset' : 'set', path: [field],
      ...(previous === undefined ? {} : { value: previous }) }]);
    const before = await view();
    const result = await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL('./verify-resident-client.mjs', import.meta.url))],
      { env: process.env, timeout: 180000, maxBuffer: 1024 * 1024 });
    process.stdout.write(result.stdout);
    const after = await view();
    assert.deepEqual(after.user, before.user, 'verification preserved stored welcome preferences');
    assert.deepEqual(after.value, before.value, 'verification preserved effective welcome preferences');
    // A real new browser still shows the user their unacknowledged notice.
    const page = await context.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('dialog', { name: 'Preview Notice', exact: true }).waitFor();
    await page.close();
    console.log(`Resident UI verification passed with ${previous ? 'legacy' : 'absent'} notice acknowledgement; the user's notice remains pending.`);
  }
} finally {
  try {
    if (original) await mutate([{ op: Object.hasOwn(original.user ?? {}, field) ? 'set' : 'unset', path: [field],
      ...(Object.hasOwn(original.user ?? {}, field) ? { value: original.user[field] } : {}) }]);
  } finally { await close(); }
}
