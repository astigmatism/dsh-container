/** CI-only removal/return test against the real Harness and rendered picker.
 *
 * One router is one route: the fixture router is a single provider whose models
 * are the services it publishes, so taking one service offline gates that model
 * row alone while its neighbour on the same route keeps answering. Every label
 * this script waits for is derived from the titles the fixture router publishes
 * for that service ID plus the one state suffix the plugin writes — never from a
 * name this script invents (docs/llm-router-contract.md §4, §5).
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { launchVerificationBrowser, verificationSessionRow } from './verification-browser.mjs';
import { installVerificationOnboarding, clickVerificationTarget } from './verification-onboarding.mjs';
import { verificationPrompt } from './verification-inference.mjs';
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
// The catalog route of this deployment and the two services the fixture router
// publishes on it: `nighttime`, whose configuration comes and goes, and its
// neighbour `daytime`, which the fixture always serves.
const route = 'local-ollama';
const night = { provider: route, model: 'nighttime' };
const day = { provider: route, model: 'daytime' };
const CLIENT_NAME = 'deepseek-harness/availability-fixture';
const fixture = async (path) => {
  const response = await fetch(`${control}${path}`, { headers: { 'x-client-name': CLIENT_NAME } });
  assert.equal(response.status, 200, `${path} answered the fixture control port`);
  return response;
};
/** The capabilities document the fixture router is publishing right now. */
const fixtureDocument = async () => (await fixture('/v1/router/capabilities')).json();
/**
 * The labels one service of this fixture can be shown under, read from the
 * document as it stands: the title a name is offered under (`alias_display_names`
 * for the name on offer, else `display_name_qualified`, else `display_name`, with
 * the published ` · NSFW` badge), and that title with exactly one state suffix
 * while the active configuration stops it.
 */
async function labels(service) {
  const document = await fixtureDocument();
  const row = (document.models ?? []).find(candidate => candidate.service === service || candidate.id === service
    || (candidate.aliases ?? []).includes(service));
  const stopped = (document.offline_services ?? []).find(candidate => (candidate.aliases ?? []).includes(service));
  const aliasTitle = row?.metadata?.alias_display_names?.[service];
  const title = (typeof aliasTitle === 'string' && aliasTitle.trim().toLowerCase() !== service.toLowerCase()
    ? aliasTitle
    : row?.display_name_qualified ?? row?.display_name ?? row?.metadata?.display_name ?? stopped?.display_name) ?? service;
  assert.ok(title !== service, `the fixture router publishes no title for ${service}`);
  return {
    title,
    serving: row !== undefined,
    nsfw: row?.nsfw === true,
    offered: row?.nsfw === true ? `${title} · NSFW` : title,
    offline: `${title} — offline (${document.configuration?.id ?? 'unknown'})`,
  };
}
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
/** One model row of the shared route as the picker catalog reports it. */
async function modelRow(service) {
  const catalog = await rpc('session/modelCatalog');
  const group = (catalog.groups ?? []).find(row => row.id === route);
  return (group?.models ?? []).find(candidate => candidate.id === service);
}
/** Whether that one row is gated; a gated row is still listed, never dispatched. */
const modelGated = async (service) => (await modelRow(service))?.available === false;
const selection = async () => {
  const catalog = await rpc('session/modelCatalog');
  return `${catalog.default.provider}/${catalog.default.model}`;
};
const selectedIs = async (service) => (await selection()) === `${route}/${service}`;
/**
 * Stop or restore one service of the shared route on the fixture router, and wait
 * until exactly that model row changed. The route itself never disappears: its
 * other model keeps answering (§5, no fallback in either direction).
 */
async function setNight(available) {
  await fetch(`${control}/__fixture/night/${available ? 'on' : 'off'}`, { headers: { 'x-client-name': CLIENT_NAME } });
  await until(async () => (await modelGated(night.model)) === !available,
    'runtime discovery refreshes the state of that one model');
}
let sessionId, workspaceId, original, workspacePath;
try {
  await installVerificationOnboarding(page, base);
  await context.request.get(`${base}/?token=${encodeURIComponent(secret)}`);
  original = (await rpc('settings/describe')).namespaces.find(row => row.ns === 'agent-default-model');
  assert.equal((await rpc('session/modelCatalog')).default.provider, 'amazon-bedrock');
  assert.ok(await modelRow(night.model), 'a service the configuration stops is still offered, with its state');
  assert.equal(await modelGated(night.model), true, 'the stopped service starts gated');
  assert.equal((await rpc('session/modelCatalog')).routableProviders.includes(route), true,
    'one gated model does not take the route out of the picker, because its neighbour answers');
  await setNight(true);
  assert.equal(await modelGated(day.model), false, 'the model the router serves was never gated by its neighbour');
  await rpc('settings/mutate', { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', night.provider, 'retryPolicy'], value: { mode: 'always' } }] });
  workspacePath = await mkdtemp('/tmp/dsh-availability-workspace-');
  const workspace = await rpc('workspace/create', { path: workspacePath });
  workspaceId = workspace.workspace.workspaceId;
  ({ sessionId } = await rpc('session/create', { workspaceId }));
  await rpc('session/selectModel', { sessionId, ...night });
  await until(async () => await selectedIs(night.model), 'the nighttime model of the shared route is the session default');
  // Persist a real conversation on one model of the route before testing its
  // disappearance. A prompt rejected before dispatch can leave a blank draft
  // hidden by Sidebar.
  await rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Materialize the nighttime fixture; do not use tools.' }] });
  await until(async () => (await (await fetch(`${control}/__fixture/requests`)).json()).includes(night.model), 'the gated model dispatch sends its own service ID');
  await rpc('session/cancel', { sessionId });
  await until(async () => !(await rpc('session/list')).items.find(row => row.sessionId === sessionId)?.running, 'nighttime fixture is idle');
  await setNight(false);
  assert.equal(await selection(), `${route}/${night.model}`, 'the session keeps the model that went offline');
  const before = await (await fetch(`${control}/__fixture/requests`)).json();
  await rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Unavailable model regression; do not use tools.' }] });
  await delay(2000);
  const after = await (await fetch(`${control}/__fixture/requests`)).json();
  assert.deepEqual(after, before, 'an offline model never invokes its own service nor falls back onto its neighbour');
  await until(async () => !(await rpc('session/list')).items.find(row => row.sessionId === sessionId)?.running, 'unavailable failure is terminal even with always-retry');
  const title = `Optional resident ${sessionId}`;
  await rpc('session/rename', { sessionId, title });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await until(async () => {
    const row = verificationSessionRow(page, title);
    if (await row.isVisible()) { await clickVerificationTarget(page, row); return true; }
    const group = page.getByRole('treeitem').filter({ has: page.getByText(workspace.workspace.title, { exact: true }) }).first();
    if (await group.count() && await group.getAttribute('aria-expanded') === 'false') {
      await clickVerificationTarget(page, group.getByText(workspace.workspace.title, { exact: true }));
    }
    return false;
  }, 'fixture session visible');
  await page.waitForSelector('[data-composer-input]');
  const trigger = page.getByRole('button', { name: /^Select model/ });
  // Labels come from the fixture router's own document: the title it publishes for
  // this service ID plus exactly one state suffix.
  const gated = await labels(night.model);
  assert.equal(gated.serving, false, 'the fixture router lists this service as stopped right now');
  assert.match(gated.offline, / — offline \(fixture-solo\)$/, 'the derived label carries the state the plugin writes for it');
  await until(async () => (await trigger.innerText()).includes(gated.offline), 'the selected model shows the offline state the router published');
  await clickVerificationTarget(page, trigger);
  await clickVerificationTarget(page, page.getByRole('menuitem', { name: /^Model/ }));
  // Exactly one state: offline, titled as the publisher titles it and suffixed with
  // the configuration ID from offline_services.
  const unavailable = page.getByRole('menuitemradio', { name: gated.offline, exact: true });
  await unavailable.waitFor();
  assert.equal(await unavailable.isDisabled(), true);
  await setNight(true);
  await delay(1000);
  assert.deepEqual(await (await fetch(`${control}/__fixture/requests`)).json(), before, 'reappearance never replays the failed prompt');
  // The same open picker must update without reload or reconnection.
  // The router declares this service NSFW; the picker carries the badge.
  const back = await labels(night.model);
  assert.equal(back.serving && back.nsfw, true, 'the router serves the returned service and declares it NSFW');
  const returned = page.getByRole('menuitemradio', { name: back.offered, exact: true });
  await until(async () => await returned.count() === 1, 'open picker observes the model return under the title the router publishes');
  assert.equal(await returned.isDisabled(), false, 'a returning model is selectable again');
  assert.equal(await selectedIs(night.model), true, 'the selection survived its own disappearance');
  await setNight(false);
  const offlineAgain = await labels(night.model);
  assert.equal(offlineAgain.offline, gated.offline, 'the same published title and state are written again');
  await until(async () => await unavailable.count() === 1, 'open picker observes removal of the selectable state');
  const served = await labels(day.model);
  assert.equal(served.serving, true, 'the fixture has served the stopped service neighbour all along');
  await clickVerificationTarget(page, page.getByRole('menuitemradio', { name: served.offered, exact: true }));
  await until(async () => await selectedIs(day.model), 'an explicit switch to the neighbour on the same route works');
  // Exercise actual history/projection shapes, not only mocked RPC replies.
  // A router error the contract does not retry (§10 INVALID_REQUEST) has to end
  // the turn on its terminal event: not retried, not read as a router
  // transition, and not left spinning until the deadline. The generic 503 this
  // fixture otherwise answers with is a contract retry, so the fixture is
  // armed for exactly this request and disarmed again straight after.
  const attempts = (await (await fetch(`${control}/__fixture/requests`)).json()).length;
  await fetch(`${control}/__fixture/poison/invalid-request`, { headers: { 'x-client-name': CLIENT_NAME } });
  try {
    await assert.rejects(verificationPrompt({ sessionId, text: 'Isolated terminal-error acceptance check.',
      timeoutMs: 30000, rpc: (method, request) => rpc(`session/${method}`, request) }),
    /Verification request ended without completion/);
  } finally {
    await fetch(`${control}/__fixture/poison/off`, { headers: { 'x-client-name': CLIENT_NAME } });
  }
  const afterPoison = (await (await fetch(`${control}/__fixture/requests`)).json()).length;
  assert.equal(afterPoison, attempts + 1, `a non-retryable router error was sent ${afterPoison - attempts} times`);
  console.log('Single-model Bedrock startup, a session retained on one gated model of the shared route, no fallback to its neighbour, and live picker removal/return passed.');
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
