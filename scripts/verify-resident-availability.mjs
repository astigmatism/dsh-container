/** CI-only removal/return test against the real Harness and rendered picker. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
const context = await browser.newContext();
// Candidate qualification has --network none: loopback works, but Chromium's
// OS connectivity hint is offline and Harness deliberately suspends its event
// stream. This fixture uses loopback only, so model a connected local client.
await context.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => true }));
const page = await context.newPage();
const browserErrors = [];
page.on('pageerror', error => browserErrors.push(error.message));
page.on('console', message => { if (['error', 'warning'].includes(message.type())) browserErrors.push(message.text()); });
page.on('requestfailed', request => browserErrors.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
const night = { provider: 'local-everyday', model: 'qwen3.8-27b-abliterated-q6_k' };
async function rpc(method, request = {}) {
  const response = await context.request.post(`${base}/api/${method}`, { data: {
    type: 'client-request', rpcId: randomUUID(), method,
    payload: { args: method.startsWith('settings/') ? request : method === 'session/modelCatalog' ? {} : method === 'session/list' ? { _request: request } : { request } },
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
let sessionId, workspaceId, original, workspacePath;
try {
  await installVerificationOnboarding(page, base);
  await context.request.get(`${base}/?token=${encodeURIComponent(secret)}`);
  original = (await rpc('settings/describe')).namespaces.find(row => row.ns === 'agent-default-model');
  assert.equal((await rpc('session/modelCatalog')).default.provider, 'amazon-bedrock');
  assert.equal((await rpc('session/modelCatalog')).routableProviders.includes(night.provider), false);
  await setNight(true);
  await rpc('settings/mutate', { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', night.provider, 'retryPolicy'], value: { mode: 'always' } }] });
  workspacePath = await mkdtemp('/tmp/dsh-availability-workspace-');
  const workspace = await rpc('workspace/create', { path: workspacePath });
  workspaceId = workspace.workspace.workspaceId;
  ({ sessionId } = await rpc('session/create', { workspaceId }));
  await rpc('session/selectModel', { sessionId, ...night });
  await until(async () => (await rpc('session/modelCatalog')).default.provider === night.provider, 'Nighttime default persisted');
  // Persist a real Nighttime conversation before testing disappearance. A
  // prompt rejected before dispatch can leave a blank draft hidden by Sidebar.
  await rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Materialize the Nighttime fixture; do not use tools.' }] });
  await until(async () => (await (await fetch(`${control}/__fixture/requests`)).json()).includes(night.model), 'Nighttime dispatch uses its exact model');
  await rpc('session/cancel', { sessionId });
  await until(async () => !(await rpc('session/list')).items.find(row => row.sessionId === sessionId)?.running, 'Nighttime fixture is idle');
  await setNight(false);
  assert.equal((await rpc('session/modelCatalog')).default.provider, night.provider);
  const before = await (await fetch(`${control}/__fixture/requests`)).json();
  await rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Unavailable model regression; do not use tools.' }] });
  await delay(2000);
  const after = await (await fetch(`${control}/__fixture/requests`)).json();
  assert.deepEqual(after, before, 'unavailable session never invokes Nighttime or a fallback');
  await until(async () => !(await rpc('session/list')).items.find(row => row.sessionId === sessionId)?.running, 'unavailable failure is terminal even with always-retry');
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
  await until(async () => /unavailable/i.test(await trigger.innerText()), 'selected Nighttime shows its unavailable status');
  await trigger.click();
  await page.getByRole('menuitem', { name: /^Model/ }).click();
  const unavailable = page.getByRole('menuitemradio', { name: 'Nighttime — unavailable', exact: true });
  await unavailable.waitFor();
  assert.equal(await unavailable.isDisabled(), true);
  await setNight(true);
  await delay(1000);
  assert.deepEqual(await (await fetch(`${control}/__fixture/requests`)).json(), before, 'reappearance never replays the failed prompt');
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
} catch (error) {
  throw new Error(`${error.message}\nSynthetic fixture browser: ${(await page.locator('body').innerText().catch(() => '')).slice(-8000)}\nBrowser diagnostics: ${browserErrors.slice(-30).join('\n').split(secret).join('[redacted]')}`, { cause: error });
} finally {
  try {
    if (sessionId) { await rpc('session/cancel', { sessionId }); await rpc('workspace/archiveSession', { sessionId }); }
    if (workspaceId) await rpc('workspace/delete', { workspaceId });
    if (original) await rpc('settings/mutate', { ns: 'agent-default-model', ops:
      ['provider', 'model', 'reasoningEffort'].map(key => Object.hasOwn(original.user ?? {}, key)
        ? { op: 'set', path: [key], value: original.user[key] } : { op: 'unset', path: [key] }) });
  } finally { await page.unrouteAll({ behavior: 'wait' }); await close(); if (workspacePath) await rm(workspacePath, { recursive: true, force: true }); }
}
