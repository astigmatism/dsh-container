import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { loadRouterContract, verifyConfiguredRoutes, residentClientExpectations } from '../scripts/verify-router-contract.mjs';
import { fakeRouter, paired, solo, draining, residentModel, legacySettings, settingsService, NIGHTTIME_MTP3_ID } from './fixtures/router-contract.mjs';
const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const contract = await loadRouterContract();
const { synchronizeRouterSettings, applyOperation, RouterWatch, ResidentDiscovery, routerClientName, ROUTER_CONTRACT_HUB } = contract;
const CLIENT = routerClientName();
const service = (state, mutations) => settingsService(state, mutations, applyOperation);
const providers = state => state['llm-pi-ai'].providers;
const canonical = /fixture-(?:daytime|nighttime)|qwen3\.8|local-active/;

async function eventually(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try { return await check(); } catch (error) { if (Date.now() > deadline) throw new Error(`${message}: ${error.message}`); }
    await delay(20);
  }
}

/** The exact remote-direct section of scripts/verify.sh, run against a settings file. */
async function remoteVerifier(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dsh-router-remote-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const verify = await readFile(path.join(root, 'scripts/verify.sh'), 'utf8');
  const start = verify.indexOf('if [ "$mode" = --remote-ollama ]; then');
  const end = verify.indexOf('\n# Trusted TLS gateway verification.', start);
  assert.ok(start >= 0 && end > start);
  const wrapper = path.join(temporary, 'remote-check.sh');
  await writeFile(wrapper, `#!/bin/sh
set -eu
mode=--remote-ollama
provider_exit=22
get_env() { echo 127.0.0.1; }
compose() {
  if [ "$4" = getent ]; then echo "127.0.0.1 ai-router"; return; fi
  [ "$4" = node ] && [ "$5" = /opt/dsh-build/verify-router-contract.mjs ] || exit 98
  shift 5
  "$TEST_NODE" "$TEST_ROOT/scripts/verify-router-contract.mjs" --settings "$TEST_SETTINGS" "$@"
}
${verify.slice(start, end)}
`);
  const settingsFile = path.join(temporary, 'settings.json');
  return async settings => {
    await writeFile(settingsFile, JSON.stringify(settings));
    return run('sh', [wrapper], { env: { ...process.env, TEST_NODE: process.execPath, TEST_ROOT: root, TEST_SETTINGS: settingsFile } });
  };
}

test('startup migration moves legacy routes to service IDs, takes limits from each serving model, and identifies itself', async t => {
  const router = await fakeRouter(t, paired());
  const remote = await remoteVerifier(t);
  const state = legacySettings(router.baseURL);
  const mutations = [];
  const { results, errors } = await synchronizeRouterSettings(service(state, mutations));
  assert.deepEqual(errors, []);
  const day = providers(state)['local-ollama'], night = providers(state)['local-everyday'];
  assert.deepEqual(day.models.map(row => row.id), ['daytime']);
  assert.deepEqual(night.models.map(row => row.id), ['nighttime']);
  assert.equal(day.models[0].contextWindow, 163840 - 1024);
  assert.equal(night.models[0].contextWindow, 98304 - 1024);
  assert.equal(day.maxConcurrency, 1, 'slots, not a stored value, set maxConcurrency');
  assert.equal(day.models[0].maxTokens, null);
  assert.equal(day.models[0].custom, 'retain');
  assert.equal(day.apiKeyEnv, 'UNCHANGED_CREDENTIAL_REFERENCE');
  assert.equal(night.models[0].name, 'Qwen3.8 27B Abliterated Q6_K (96K) · NSFW');
  assert.equal(day.headers['X-Client-Name'], CLIENT);
  assert.equal(night.headers['X-Client-Name'], CLIENT);
  assert.equal(results.get('local-everyday').state.status, 'available');
  assert.deepEqual(Object.keys(providers(state)).sort(), ['custom', 'local-everyday', 'local-ollama']);
  assert.deepEqual(state['agent-default-model'], { provider: 'local-ollama', model: 'daytime', reasoningEffort: 'off', custom: 'retain' });
  assert.deepEqual(state['custom-setting'], { preserved: true });
  assert.doesNotMatch(JSON.stringify(state['llm-pi-ai'].providers['local-ollama']) + JSON.stringify(night), canonical,
    'nothing persisted refers to a canonical model ID');
  assert.ok(router.state.clientNames.every(name => name === CLIENT), 'every discovery fetch sends X-Client-Name');
  const count = mutations.length;
  await synchronizeRouterSettings(service(state, mutations));
  assert.equal(mutations.length, count, 'migration is idempotent');
  await verifyConfiguredRoutes(state, { browser: true });
  assert.match((await remote(state)).stdout, /Verified/);
  state['agent-default-model'] = { provider: 'local-everyday', model: 'nighttime' };
  await assert.rejects(verifyConfiguredRoutes(state, { browser: true }), /missing vision capability/);
});

test('solo configuration: Nighttime offline with the configuration ID never blocks Daytime or verification', async t => {
  const router = await fakeRouter(t, solo());
  const remote = await remoteVerifier(t);
  const state = legacySettings(router.baseURL);
  const bedrock = { api: 'bedrock-converse-stream', region: 'us-west-2', apiKeyEnv: 'BEDROCK_SECRET' };
  providers(state)['amazon-bedrock'] = bedrock;
  state['agent-default-model'] = { provider: 'amazon-bedrock', model: 'external-model', reasoningEffort: 'high' };
  await synchronizeRouterSettings(service(state));
  const night = providers(state)['local-everyday'];
  assert.equal(night.residentUnavailable, true);
  assert.equal(night.residentState.status, 'offline');
  assert.equal(night.residentState.label, 'Nighttime — offline (flash-next-solo-128k)');
  assert.equal(night.residentState.limits, 'stale');
  assert.deepEqual(night.models.map(row => row.id), ['nighttime']);
  assert.equal(providers(state)['local-ollama'].models[0].contextWindow, 131072 - 1024);
  assert.deepEqual(providers(state)['amazon-bedrock'], bedrock);
  assert.deepEqual(state['agent-default-model'], { provider: 'amazon-bedrock', model: 'external-model', reasoningEffort: 'high' });
  const notices = [];
  const rows = await verifyConfiguredRoutes(state, { log: notice => notices.push(notice) });
  assert.deepEqual(rows.map(row => row.status), ['available', 'offline']);
  assert.match(notices.join('\n'), /nighttime: offline \(flash-next-solo-128k\); skipped/);
  const output = await remote(state);
  assert.match(output.stdout, /nighttime: offline \(flash-next-solo-128k\); skipped/);
  assert.match(output.stdout, /Verified/);
  const expected = await residentClientExpectations(state);
  assert.deepEqual(expected.map(row => [row.name, row.available]), [['Qwen3.8 Flash-Next (128K)', true], ['Nighttime — offline (flash-next-solo-128k)', false]]);
});

for (const [label, document, status] of [
  ['unhealthy', paired({ models: [residentModel({ contextWindow: 196608 }), residentModel({ service: 'nighttime', available: false })] }), 'unavailable'],
  ['incomplete', (() => {
    const night = residentModel({ service: 'nighttime' });
    night.metadata.warnings = ['BACKEND_SLOT_CONTEXT_MISMATCH'];
    return paired({ models: [residentModel({ contextWindow: 196608 }), night] });
  })(), 'incomplete'],
]) {
  test(`Nighttime ${label}: recorded on its own while Daytime limits still update`, async t => {
    const router = await fakeRouter(t, paired());
    const state = legacySettings(router.baseURL);
    await synchronizeRouterSettings(service(state));
    const before = structuredClone(providers(state)['local-everyday'].models);
    router.publish(document);
    const { errors } = await synchronizeRouterSettings(service(state));
    assert.deepEqual(errors, []);
    assert.equal(providers(state)['local-ollama'].models[0].contextWindow, 196608 - 1024, 'Daytime is never frozen by Nighttime');
    const night = providers(state)['local-everyday'];
    assert.equal(night.residentState.status, status);
    assert.equal(night.residentUnavailable, true);
    assert.deepEqual(night.models, before, 'last limits are retained, marked stale');
    assert.equal(night.residentState.limits, 'stale');
    await verifyConfiguredRoutes(state);
  });
}

test('router draining: both models wait (not blocked), limits stay stale, verification passes', async t => {
  const router = await fakeRouter(t, paired());
  const state = legacySettings(router.baseURL);
  await synchronizeRouterSettings(service(state));
  router.publish(draining());
  await synchronizeRouterSettings(service(state));
  for (const name of ['local-ollama', 'local-everyday']) {
    assert.equal(providers(state)[name].residentState.status, 'switching');
    assert.equal(providers(state)[name].residentUnavailable, false);
    assert.match(providers(state)[name].residentState.label, /— router switching configuration$/);
  }
  assert.deepEqual((await verifyConfiguredRoutes(state)).map(row => row.status), ['switching', 'switching']);
});

test('router unreachable at startup: stored settings are kept, both models are unavailable, discovery recovers', async t => {
  const router = await fakeRouter(t, paired());
  const state = legacySettings(router.baseURL);
  const stored = structuredClone(providers(state)['local-ollama'].models[0]);
  router.unreachable();
  const failures = [];
  const { errors, results } = await synchronizeRouterSettings(service(state), { onFetchError: (_base, error) => failures.push(error) });
  assert.deepEqual(errors, [], 'an unreachable router is not a startup failure');
  assert.equal(failures.length, 1);
  for (const name of ['local-ollama', 'local-everyday']) {
    assert.equal(results.get(name).state.reason, 'router unreachable');
    assert.equal(providers(state)[name].residentUnavailable, true);
  }
  assert.equal(providers(state)['local-ollama'].models[0].contextWindow, stored.contextWindow);
  assert.deepEqual(providers(state)['local-ollama'].models.map(row => row.id), ['daytime'], 'local migration still happens');
  router.reachable();
  await synchronizeRouterSettings(service(state));
  assert.equal(providers(state)['local-ollama'].residentState.status, 'available');
  assert.equal(providers(state)['local-ollama'].residentUnavailable, false);
});

test('a new canonical ID behind nighttime between revisions keeps it available with nothing canonical persisted', async t => {
  const router = await fakeRouter(t, paired());
  const state = legacySettings(router.baseURL);
  await synchronizeRouterSettings(service(state));
  router.publish(paired({ models: [residentModel(), residentModel({ service: 'nighttime', id: NIGHTTIME_MTP3_ID, contextWindow: 131072 })] }));
  await synchronizeRouterSettings(service(state));
  const night = providers(state)['local-everyday'];
  assert.equal(night.residentState.status, 'available');
  assert.equal(night.models[0].contextWindow, 131072 - 1024);
  assert.doesNotMatch(JSON.stringify(state), /fixture-nighttime|mtp3/);
  await verifyConfiguredRoutes(state);
});

test('the live verifier rejects stale limits, labels, identity and canonical IDs', async t => {
  const router = await fakeRouter(t, paired());
  const remote = await remoteVerifier(t);
  const state = legacySettings(router.baseURL);
  await synchronizeRouterSettings(service(state));
  const saved = structuredClone(providers(state)['local-ollama']);
  for (const [mutate, pattern] of [
    [day => { day.models[0].contextWindow = 131072; }, /context is not synchronized/],
    [day => { day.models[0].name = 'Daytime (128K)'; }, /display name is not synchronized/],
    [day => { day.maxConcurrency = 2; }, /concurrency is not synchronized/],
    [day => { delete day.headers; }, /X-Client-Name/],
    [day => { day.models[0].id = 'local-active'; }, /service ID "daytime"/],
    [day => { day.residentUnavailable = true; }, /availability is not synchronized/],
  ]) {
    providers(state)['local-ollama'] = structuredClone(saved);
    mutate(providers(state)['local-ollama']);
    await assert.rejects(verifyConfiguredRoutes(state), pattern);
    await assert.rejects(remote(state), error => error.code === 22 && pattern.test(error.stderr));
  }
  providers(state)['local-ollama'] = saved;
  await verifyConfiguredRoutes(state);
});

test('rollback verification accepts settings from releases that predate service IDs', async t => {
  const router = await fakeRouter(t, solo());
  const state = legacySettings(router.baseURL);
  delete providers(state)['local-ollama-256k'];
  providers(state)['local-everyday'].residentUnavailable = true;
  await assert.rejects(verifyConfiguredRoutes(state), /service ID/);
  const rows = await verifyConfiguredRoutes(state, { allowLegacyIds: true, primaryBrowser: true });
  assert.deepEqual(rows.map(row => row.status), ['available', 'offline']);
});

test('a concurrent edit to a resident route is never overwritten; the other model still converges', async t => {
  const router = await fakeRouter(t, paired());
  const state = legacySettings(router.baseURL);
  const settings = service(state);
  const describe = settings.describe;
  let reads = 0;
  settings.describe = () => {
    if (++reads === 3) providers(state)['local-ollama'].apiKeyEnv = 'NEW_CREDENTIAL_REFERENCE';
    return describe();
  };
  const { errors } = await synchronizeRouterSettings(settings);
  assert.match(errors.map(row => `${row.provider}: ${row.error.message}`).join('\n'), /local-ollama: resident settings changed during discovery/);
  assert.equal(providers(state)['local-ollama'].apiKeyEnv, 'NEW_CREDENTIAL_REFERENCE');
  assert.deepEqual(providers(state)['local-everyday'].models.map(row => row.id), ['nighttime'], 'Nighttime is independent of Daytime');
});

test('event stream: revisions are followed, the stream reconnects with backoff, and polling revalidates with If-None-Match', async t => {
  const router = await fakeRouter(t, paired());
  const documents = [];
  const reachability = [];
  const watch = new RouterWatch(router.baseURL, { clientName: CLIENT, pollMs: 200, retryMs: 40, maxRetryMs: 120, deadMs: 300,
    onDocument: document => documents.push(document.revision), onReachability: reachable => reachability.push(reachable) }).start();
  t.after(() => watch.stop());
  await eventually(() => assert.equal(router.state.eventConnections, 1), 'subscribes to /v1/router/events');
  const first = router.state.document.revision;
  await eventually(() => assert.deepEqual(documents, [first]), 'the startup document is read once per revision');
  const next = solo();
  router.publish(next);
  await eventually(() => assert.equal(documents.at(-1), next.revision), 'a capabilities event replaces the copy');
  router.disconnect();
  await eventually(() => assert.equal(router.state.eventConnections, 2), 'reconnects after a drop');
  assert.ok(router.state.notModified >= 1, 'polls while disconnected with If-None-Match');
  assert.equal(documents.filter(revision => revision === next.revision).length, 1, 'an unchanged revision is not re-applied');
  // 60 s (here 300 ms) without bytes, keepalives included, is a dead stream.
  const keepalive = setInterval(() => router.keepalive(), 50);
  await delay(450);
  clearInterval(keepalive);
  assert.equal(router.state.eventConnections, 2, 'keepalives keep the stream alive');
  await eventually(() => assert.equal(router.state.eventConnections, 3), 'a silent stream is replaced', 2000);
  assert.ok(router.state.clientNames.every(name => name === CLIENT));
  assert.deepEqual(reachability, [true]);
});

test('TOO_MANY_SUBSCRIBERS falls back to polling the capabilities endpoint', async t => {
  const router = await fakeRouter(t, paired());
  router.state.refuseEvents = true;
  const documents = [];
  const watch = new RouterWatch(router.baseURL, { clientName: CLIENT, pollMs: 100, retryMs: 20, maxRetryMs: 100, deadMs: 500,
    onDocument: document => documents.push(document.revision) }).start();
  t.after(() => watch.stop());
  await eventually(() => assert.equal(documents.length, 1), 'startup document');
  router.state.document = solo();
  await eventually(() => assert.equal(documents.at(-1), router.state.document.revision), 'polling picks up a change');
});

test('discovery service: transitions are logged and pushed, request-time codes re-sync, and models return with no action', async t => {
  const router = await fakeRouter(t, paired());
  const state = legacySettings(router.baseURL);
  const logs = [];
  const logger = { info: message => logs.push(message), warn: message => logs.push(message) };
  let describes = 0;
  const settings = service(state);
  const describe = settings.describe;
  settings.describe = () => { describes += 1; return describe(); };
  const discovery = new ResidentDiscovery({ settings, logger, pollIntervalMs: 60_000, clientName: CLIENT, echo: false,
    watchOptions: { retryMs: 30, maxRetryMs: 100, deadMs: 1000, pollMs: 200 } }).start();
  t.after(() => discovery.stop());
  const night = () => providers(state)['local-everyday'];
  await eventually(() => assert.equal(night().residentState?.status, 'available'), 'startup sync');
  router.publish(solo());
  await eventually(() => assert.equal(night().residentState.status, 'offline'), 'a pushed revision re-syncs immediately');
  assert.ok(logs.includes('router-model-discovery: nighttime: available → offline (flash-next-solo-128k)'), logs.join('\n'));
  assert.ok(describes > 0, 'settings/document-updated is flushed for open pickers');
  router.publish(paired());
  await eventually(() => assert.equal(night().residentState.status, 'available'), 'Nighttime becomes selectable again with no action');
  assert.equal(night().residentUnavailable, false);
  // The document can lag: a SERVICE_OFFLINE answer marks the model offline at once.
  const hub = globalThis[ROUTER_CONTRACT_HUB];
  hub.report('local-everyday', { code: 'SERVICE_OFFLINE', message: 'X is offline in runtime configuration "flash-next-solo-128k" (exclusive_configuration).' });
  await eventually(() => assert.equal(night().residentState.status, 'offline'), 'SERVICE_OFFLINE holds the model offline');
  assert.equal(night().residentState.configuration, 'flash-next-solo-128k');
  router.publish(solo());
  await eventually(() => assert.equal(night().residentState.reason, 'exclusive_configuration'), 'the document supersedes the hold');
  router.publish(paired());
  await eventually(() => assert.equal(night().residentState.status, 'available'), 'returns again');
  // BACKEND_UNAVAILABLE after the bounded provider retries marks it unavailable.
  for (let attempt = 0; attempt < 3; attempt += 1) hub.report('local-everyday', { code: 'BACKEND_UNAVAILABLE' });
  await eventually(() => assert.equal(night().residentState.status, 'unavailable'), 'repeated backend failures mark it unavailable');
  assert.equal(providers(state)['local-ollama'].residentState.status, 'available', 'Daytime is independent');
  router.publish(paired());
  await eventually(() => assert.equal(night().residentState.status, 'available'), 'a new revision clears the hold');
  // Router gone: both unavailable; back: recovered automatically.
  router.unreachable();
  await eventually(() => assert.equal(providers(state)['local-ollama'].residentState.reason, 'router unreachable'), 'unreachable', 5000);
  assert.ok(logs.some(line => line === 'router-model-discovery: daytime: available → unavailable (router unreachable)'), logs.join('\n'));
  router.reachable();
  await eventually(() => assert.equal(providers(state)['local-ollama'].residentState.status, 'available'), 'recovers', 5000);
});

test('a pre-contract router without /v1/router/capabilities keeps Daytime usable from its model listing', async t => {
  const http = await import('node:http');
  const listing = { data: [{ id: 'local-active', object: 'model', x_ollama_router: {
    schema_version: 1, alias: true, upstream_model: 'fixture-managed:q8', context_window: 262144, active_request_limit: 1,
    input_modalities: ['text', 'image'], capabilities: ['completion', 'thinking', 'tools', 'vision'], complete: true, warnings: [] } }] };
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push([req.url, req.headers['x-client-name']]);
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(listing)); return; }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":{"code":"NOT_FOUND"}}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const state = legacySettings(`http://127.0.0.1:${server.address().port}/v1`);
  const before = structuredClone(providers(state)['local-ollama'].models[0]);
  const { errors } = await synchronizeRouterSettings(service(state));
  assert.deepEqual(errors, []);
  const day = providers(state)['local-ollama'];
  assert.equal(day.residentUnavailable, false);
  assert.equal(day.residentState.status, 'available');
  assert.equal(day.residentState.limits, 'stored');
  assert.equal(day.models[0].contextWindow, before.contextWindow, 'unpublished limits are not invented');
  assert.deepEqual(day.models.map(row => row.id), ['daytime']);
  assert.equal(providers(state)['local-everyday'].residentState.status, 'unavailable');
  assert.ok(seen.some(([url, name]) => url === '/v1/models' && name === CLIENT));
  const rows = await verifyConfiguredRoutes(state, { log() {} });
  assert.deepEqual(rows.map(row => row.status), ['available', 'unavailable']);
});
