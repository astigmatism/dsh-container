/** CI-only removal/return test against the real Harness and rendered picker. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { launchVerificationBrowser } from './verification-browser.mjs';
import { installVerificationOnboarding, dismissVerificationOnboarding } from './verification-onboarding.mjs';
const profile = process.env.DSH_PROFILE_ROOT;
assert.match(profile ?? '', /^\/tmp\/dsh-router-startup-[^/]+\/runtime\/profiles\/web$/);
const control = process.env.DSH_AVAILABILITY_FIXTURE;
assert.match(control ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
const base = process.env.DSH_VERIFY_URL, secret = process.env.DSH_BOOT_TOKEN;
assert.ok(base && secret);
const require = createRequire(`${profile}/package.json`);
const { browser, close } = await launchVerificationBrowser(require('playwright-core').chromium);
const context = await browser.newContext(), page = await context.newPage();
const night = { provider: 'local-everyday', model: 'qwen3.8-27b-abliterated-q6_k' };
async function rpc(method, request = {}) {
  const response = await context.request.post(`${base}/api/${method}`, { data: {
    type: 'client-request', rpcId: randomUUID(), method,
    payload: { args: method.startsWith('settings/') ? request : method === 'session/modelCatalog' ? {} : { request } },
  } });
  assert.equal(response.status(), 200);
  const body = await response.json();
  assert.equal(body.result.ok, true, `${method}: ${body.result.error?.message}`);
  return body.result.value;
}
async function until(check, message) {
  const deadline = Date.now() + 65000;
  while (!await check()) { assert.ok(Date.now() < deadline, message); await delay(250); }
}
async function setNight(available) {
  await fetch(`${control}/__fixture/night/${available ? 'on' : 'off'}`);
  await until(async () => {
    const catalog = await rpc('session/modelCatalog');
    return catalog.routableProviders.includes(night.provider) === available;
  }, 'runtime discovery refreshes optional availability');
}
let sessionId, workspaceId, original;
try {
  await installVerificationOnboarding(page, base);
  await context.request.get(`${base}/?token=${encodeURIComponent(secret)}`);
  original = (await rpc('settings/describe')).namespaces.find(row => row.ns === 'agent-default-model');
  assert.equal((await rpc('session/modelCatalog')).default.provider, 'amazon-bedrock');
  assert.equal((await rpc('session/modelCatalog')).routableProviders.includes(night.provider), false);
  await setNight(true);
  const workspace = await rpc('workspace/create', { path: profile });
  workspaceId = workspace.workspace.workspaceId;
  ({ sessionId } = await rpc('session/create', { workspaceId }));
  await rpc('session/selectModel', { sessionId, ...night });
  await until(async () => (await rpc('session/modelCatalog')).default.provider === night.provider, 'Nighttime default persisted');
  await setNight(false);
  assert.equal((await rpc('session/modelCatalog')).default.provider, night.provider);
  const before = await (await fetch(`${control}/__fixture/requests`)).json();
  await rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Unavailable model regression; do not use tools.' }] });
  await delay(2000);
  const after = await (await fetch(`${control}/__fixture/requests`)).json();
  assert.deepEqual(after, before, 'unavailable session never invokes Nighttime or a fallback');
  await rpc('session/cancel', { sessionId });
  const title = `Optional resident ${sessionId}`;
  await rpc('session/rename', { sessionId, title });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await until(async () => {
    await dismissVerificationOnboarding(page);
    const row = page.getByText(title, { exact: true });
    if (await row.isVisible()) { await row.click(); return true; }
    const group = page.getByRole('treeitem').filter({ has: page.getByText(workspace.workspace.title, { exact: true }) }).first();
    if (await group.count() && await group.getAttribute('aria-expanded') === 'false') {
      await group.getByText(workspace.workspace.title, { exact: true }).click();
    }
    return false;
  }, 'fixture session visible');
  await page.waitForSelector('[data-composer-input]');
  const trigger = page.getByRole('button', { name: /^Select model/ });
  assert.match(await trigger.innerText(), /unavailable/i);
  await trigger.click();
  await page.getByRole('menuitem', { name: /^Model/ }).click();
  const unavailable = page.getByRole('menuitemradio', { name: 'Nighttime — unavailable', exact: true });
  await unavailable.waitFor();
  assert.equal(await unavailable.isDisabled(), true);
  await setNight(true);
  // The same open picker must update without reload or reconnection.
  await until(async () => await page.getByRole('menuitemradio', { name: 'Secondary fixture', exact: true }).count() === 1,
    'open picker observes Nighttime return');
  assert.equal(await page.getByRole('menuitemradio', { name: 'Secondary fixture', exact: true }).isDisabled(), false);
  assert.equal((await rpc('session/modelCatalog')).default.provider, night.provider);
  await setNight(false);
  await until(async () => await unavailable.count() === 1, 'open picker observes removal');
  await page.getByRole('menuitemradio', { name: 'Primary fixture', exact: true }).click();
  await until(async () => (await rpc('session/modelCatalog')).default.provider === 'local-ollama', 'explicit Daytime switch works');
  console.log('Single-model Bedrock startup, retained Nighttime session, no fallback, and live picker removal/return passed.');
} finally {
  try {
    if (sessionId) { await rpc('session/cancel', { sessionId }); await rpc('workspace/archiveSession', { sessionId }); }
    if (workspaceId) await rpc('workspace/delete', { workspaceId });
    if (original) await rpc('settings/mutate', { ns: 'agent-default-model', ops:
      ['provider', 'model', 'reasoningEffort'].map(key => Object.hasOwn(original.user ?? {}, key)
        ? { op: 'set', path: [key], value: original.user[key] } : { op: 'unset', path: [key] }) });
  } finally { await close(); }
}
