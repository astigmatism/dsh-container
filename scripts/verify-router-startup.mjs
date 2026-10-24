#!/usr/bin/env node
/** Exercise deterministic migration through the real entrypoint in a throwaway home.
 *
 * The settings this home starts from were written by a one-route-per-service
 * release: a route per resident, a default naming a retired route, and a model
 * row named after the pre-service-ID alias. After the entrypoint runs, one route
 * remains per router and its models are exactly the catalog the fixture router
 * publishes — one row per service ID, titled with the fixture's own published
 * titles, each carrying its own state in the provider's `residentStates` map,
 * while the route's own record describes only the router.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { readSettings, verifyConfiguredRoutes } from './verify-router-contract.mjs';
const exec = promisify(execFile);
const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-router-startup-'));
const runtime = path.join(parent, 'runtime');
const tokenIndexPath = path.join(runtime, 'storages/dsh_token_index.json');
const tokenIndex = JSON.stringify({ unit: { name: 'dsh_token_index', version: 1 },
  global: { v: 1, data: { tz: 'UTC', foldVersion: 1, builtAt: 1 } }, tables: { shards: {} } });
const primaryId = 'fixture-daytime-q8';
const daytimeOnly = process.argv.includes('--daytime-only');
const secondaryId = 'fixture-nighttime-q6';
const reasoning = {
  supported: true, default: 'default', output_limit_policy: 'reject', absolute_max_output_tokens: null,
  efforts: { default: 'default', off: 'none', low: 'low', medium: 'medium', xhigh: 'xhigh' },
  aliases: { minimal: 'low', high: 'xhigh', max: 'xhigh' },
  per_effort: Object.fromEntries(['default', 'off', 'low', 'medium', 'xhigh'].map(level => [level, {
    enabled: level !== 'off', default_output_tokens: null, max_output_tokens: null
  }]))
};
// Synthetic LLM Router capabilities (docs/llm-router-contract.md §4). Canonical
// IDs are fixture-only and must never be persisted by Harness.
const residents = [primaryId, secondaryId].map((id, index) => {
  const service = index ? 'nighttime' : 'daytime';
  const metadata = {
    schema_version: 2, complete: true, warnings: [], alias: false, upstream_model: id,
    aliases: index ? ['nighttime'] : ['local-active', 'daytime'], display_name: index ? 'Secondary fixture' : 'Primary fixture',
    context_window: 131072, context_safety_reserve: 1024, active_request_limit: 1,
    output_policy: 'unrestricted', max_output_tokens: null, default_output_tokens: null,
    input_modalities: index ? ['text'] : ['text', 'image'],
    capabilities: index ? ['completion', 'thinking'] : ['completion', 'thinking', 'tools', 'vision'],
    health: { available: true, status: 200 }, nsfw: index === 1, reasoning,
  };
  return { id, service, display_name: metadata.display_name, aliases: metadata.aliases, available: true, slots: 1,
    context_window: 131072, input_modalities: metadata.input_modalities, capabilities: metadata.capabilities,
    nsfw: index === 1, capability_score: index ? 60 : 70, metadata };
});
// The third resident is the opt-in trial: text-only, and only ever selected by
// a human. In the daytime-only qualification the router stops offering it, which
// leaves that one model row held with a stated reason while the route keeps
// serving the models the configuration offers — and never a failed update.
const trialId = 'fixture-trial-q4';
const trialMetadata = {
  schema_version: 2, complete: true, warnings: [], alias: false, upstream_model: trialId,
  aliases: ['trial'], display_name: 'Trial fixture', context_window: 131072, context_safety_reserve: 1024,
  active_request_limit: 1, output_policy: 'unrestricted', max_output_tokens: null, default_output_tokens: null,
  input_modalities: ['text'], capabilities: ['completion', 'thinking'],
  health: { available: true, status: 200 }, nsfw: false, reasoning,
};
const allResidents = [...residents, { id: trialId, service: 'trial', display_name: trialMetadata.display_name,
  aliases: trialMetadata.aliases, available: true, slots: 1, context_window: 131072,
  input_modalities: trialMetadata.input_modalities, capabilities: trialMetadata.capabilities, nsfw: false,
  capability_score: 55, metadata: trialMetadata }];
/**
 * What the fixture publishes for its own names: the title it offers for a name on
 * offer, and the entry its active configuration stops. The expectations below read
 * those published facts, so they never depend on a name Harness might invent.
 */
const offlineEntry = row => ({ model: row.id, aliases: row.aliases, display_name: row.display_name,
  role: row.service === 'trial' ? 'trial' : 'everyday', reason: 'exclusive_configuration' });
const publishedTitle = Object.fromEntries(allResidents.map(row => [row.service, row.display_name]));
const publishedNsfw = Object.fromEntries(allResidents.map(row => [row.service, row.nsfw === true]));
/** dshReasoningEfforts: the DSH selector levels this fixture's reasoning map answers. */
const effortMap = Object.fromEntries(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].flatMap(level => {
  const wire = reasoning.efforts[level] ?? reasoning.efforts[reasoning.aliases[level]];
  return typeof wire === 'string' ? [[level, wire]] : [];
}));
/** The budget of a served model: the published context_window less its safety reserve. */
const servedBudget = 131072 - 1024;
/** §3: the reserved compatibility alias is not a service; older settings carried it as a model row. */
const COMPATIBILITY_ALIAS = 'local-active';
/** The one-route-per-service releases this router model discovery retires. */
const RETIRED_ROUTES = { 'local-everyday': 'nighttime', 'local-trial': 'trial' };
/** The route list the deployment declares for this router (profiles/web plugins): one route, trial opt-in. */
const ROUTER_PROVIDER = 'local-ollama';
const DISCOVERY = { providers: [ROUTER_PROVIDER], optInServices: ['trial'] };
/** The rows the catalog route carries in either configuration: one per service the
 * router publishes, plus a name it stops answering, which keeps its row and states
 * its state (§5). The pre-service-ID name these settings carried is the exception:
 * §3 says the compatibility alias is not a service, so it is not kept as a model. */
const catalogRows = ['daytime', 'nighttime', 'trial'];
let nightOnline = !daytimeOnly;
let trialOnline = !daytimeOnly;
let revision = 0;
const subscribers = new Set();
function capabilities() {
  const models = allResidents.filter((model, index) => index === 0 || (index === 1 ? nightOnline : trialOnline));
  const offline = [];
  if (!nightOnline) offline.push(offlineEntry(residents[1]));
  if (!trialOnline) offline.push(offlineEntry(allResidents[2]));
  return {
    object: 'router.capabilities', schema_version: 1, revision: `fixture-${revision}`, complete: true, warnings: [],
    router: { name: 'fixture-router', version: '0', accepting_requests: true, draining: false, drain_reason: null, maintenance: false },
    configuration: { id: nightOnline ? 'fixture-paired' : 'fixture-solo', exclusive: !nightOnline },
    default_model: primaryId, models,
    offline_services: offline,
    ids: Object.fromEntries(models.flatMap(model => [[model.id, model.id], ...model.aliases.map(alias => [alias, model.id])])),
  };
}
function publish() {
  revision += 1;
  const frame = `event: capabilities\nid: fixture-${revision}\ndata: ${JSON.stringify(capabilities())}\n\n`;
  for (const response of subscribers) response.write(frame);
}
const inferenceRequests = [];
const server = http.createServer((request, response) => {
  if (daytimeOnly && request.url.startsWith('/__fixture/')) {
    if (request.url === '/__fixture/night/on' && !nightOnline) { nightOnline = true; publish(); }
    if (request.url === '/__fixture/night/off' && nightOnline) { nightOnline = false; publish(); }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(inferenceRequests)); return;
  }
  const clientName = request.headers['x-client-name'];
  if (typeof clientName !== 'string' || !clientName.startsWith('deepseek-harness/')) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'FIXTURE_CLIENT_NAME_REQUIRED', message: 'X-Client-Name is required' } })); return;
  }
  if (request.method === 'POST') {
    let body = ''; request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const model = JSON.parse(body).model;
      inferenceRequests.push(model);
      if (model === 'nighttime' && !nightOnline) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Secondary fixture is offline in runtime configuration "fixture-solo" (exclusive_configuration).', type: 'server_error', param: 'model', code: 'SERVICE_OFFLINE' } }));
        return;
      }
      response.writeHead(503); response.end('synthetic inference unavailable');
    });
    return;
  }
  if (request.url === '/v1/router/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write(`retry: 3000\n\nevent: capabilities\nid: fixture-${revision}\ndata: ${JSON.stringify(capabilities())}\n\n`);
    subscribers.add(response);
    const keepalive = setInterval(() => response.write(': keepalive\n\n'), 15000);
    response.once('close', () => { clearInterval(keepalive); subscribers.delete(response); });
    return;
  }
  if (request.url === '/v1/router/capabilities') {
    const etag = `"fixture-${revision}"`;
    if (request.headers['if-none-match'] === etag) { response.writeHead(304, { etag }); response.end(); return; }
    response.writeHead(200, { 'content-type': 'application/json', etag });
    response.end(JSON.stringify(capabilities()));
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { code: 'MODEL_NOT_FOUND', message: 'fixture route' } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
let child;
let bootLog = '';
const webBase = 'http://127.0.0.1:3080';
let cookie;
function start() {
  child = spawn('/usr/local/bin/dsh-entrypoint', [], {
    cwd: parent, detached: true, env: { ...process.env, DSH_HOME: runtime, DSH_TELEMETRY_DISABLED: '1', STARTUP_FIXTURE_KEY: 'fixture-only' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { bootLog += chunk; });
  child.stderr.on('data', chunk => { bootLog += chunk; });

}
async function stop() {
  if (!child?.pid) return;
  const current = child;
  const closed = new Promise(resolve => current.once('close', resolve));
  try { process.kill(-current.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))]);
  try { process.kill(-current.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  child = undefined;
}
async function authenticate() {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Harness exited during persistence qualification');
    try {
      const token = (await fs.readFile(path.join(runtime, 'web-launch-token'), 'utf8')).trim();
      const response = await fetch(`${webBase}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
      cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      if (cookie) {
        await rpc('settings/describe');
        return;
      }
    } catch { /* Wait for the process and its settings owner to finish mounting. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Authenticated settings API did not become ready');
}
async function rpc(method, args = {}) {
  const response = await fetch(`${webBase}/api/${method}`, { method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: webBase },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) });
  assert.equal(response.status, 200, method);
  const { result } = await response.json();
  assert.equal(result.ok, true, `${method}: ${result.error?.message}`);
  return result.value;
}

try {
  await fs.symlink('/opt/dsh-local-speech', path.join(parent, 'dsh-local-speech'));
  await exec('/usr/local/bin/dsh-sync-runtime-profile', { env: { ...process.env, DSH_HOME: runtime } });
  await fs.mkdir(path.dirname(tokenIndexPath), { recursive: true });
  await fs.writeFile(tokenIndexPath, tokenIndex, { mode: 0o600 });
  const tokenIndexBefore = await fs.stat(tokenIndexPath);
  const provider = { api: 'openai-responses', baseURL, apiKeyEnv: 'STARTUP_FIXTURE_KEY', reasoning: 'medium', maxConcurrency: 2,
    models: [{ id: 'local-active', name: 'Old profile', contextWindow: 262144, maxTokens: 32768, input: ['text', 'image'] }] };
  // A deployment written by a one-route-per-service release: each resident had its own
  // route carrying one model. The migration merges those services into the catalog route
  // as rows of their own and drops the routes, so the picker never shows the router twice.
  const retiredRoute = service => ({ ...structuredClone(provider), maxConcurrency: 1,
    models: [{ id: service, name: `Old ${service}`, contextWindow: 131072, maxTokens: null, input: ['text'] }] });
  const settings = {
    'agent-default-model': { provider: 'local-ollama-256k', model: 'local-active', reasoningEffort: 'off' },
    'permission': { defaultPreset: 'danger-full-access' },
    'ui-onboarding': { welcomeNoticeVersion: '2026-08-13.1' },
    'llm-pi-ai': { providers: {
      'local-ollama': provider,
      'local-ollama-256k': { ...structuredClone(provider), maxConcurrency: 1 },
      'local-everyday': retiredRoute('nighttime'),
      'local-trial': retiredRoute('trial'),
      'unrelated-fixture': { ...structuredClone(provider), baseURL: 'http://unrelated.invalid/v1', reasoning: 'low' }
    }}
  };
  if (daytimeOnly) {
    settings['llm-pi-ai'].providers['amazon-bedrock'] = { apiKeyEnv: 'STARTUP_FIXTURE_KEY',
      models: [{ id: 'amazon.nova-lite-v1:0' }] };
    settings['agent-default-model'] = { provider: 'amazon-bedrock', model: 'amazon.nova-lite-v1:0' };
  }
  const expectedDefault = daytimeOnly ? structuredClone(settings['agent-default-model']) : { provider: 'local-ollama', model: 'daytime', reasoningEffort: 'off' };
  const settingsPath = path.join(runtime, 'settings.yaml');
  await fs.writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  start();
  // No browser or agent creation: migration must complete before DSH launches.
  let lastError;
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw new Error('Harness exited during router startup qualification');
    try {
      const current = await readSettings(settingsPath);
      // The plugin follows the route list the deployment declares for it; the other
      // providers in this synthetic home are not routers, so the router verification is
      // told which route discovery owns (profiles/web plugins: `providers: [local-ollama]`).
      await verifyConfiguredRoutes({ ...current, 'router-model-discovery': DISCOVERY }, { primaryBrowser: true });
      const route = current['llm-pi-ai'].providers[ROUTER_PROVIDER];
      const states = route.residentStates;
      const rows = Object.fromEntries(route.models.map(row => [row.id, row]));
      const configuration = nightOnline ? 'fixture-paired' : 'fixture-solo';
      // One slot per distinct model the fixture offers.
      const offered = ['daytime', ...(nightOnline ? ['nighttime'] : []), ...(trialOnline ? ['trial'] : [])];
      // One route per router. The one-route-per-service releases are retired: their
      // services are model rows of this route now, and a leftover route would show the
      // same router in the picker twice.
      for (const retired of Object.keys(RETIRED_ROUTES)) {
        assert.equal(current['llm-pi-ai'].providers[retired], undefined,
          `${retired} is retired: its service is a model row of ${ROUTER_PROVIDER}`);
      }
      assert.equal(current['llm-pi-ai'].providers['local-ollama-256k'], undefined,
        'the retired pre-service-ID route goes once nothing selects it');
      assert.deepEqual(current['agent-default-model'], expectedDefault);
      assert.deepEqual(Object.keys(current['llm-pi-ai'].providers).sort(),
        [...(daytimeOnly ? ['amazon-bedrock'] : []), ROUTER_PROVIDER, 'unrelated-fixture'].sort());
      assert.equal(route.apiKeyEnv, 'STARTUP_FIXTURE_KEY', 'the credential reference survives the catalog rewrite');
      assert.equal(route.reasoning, 'medium', 'the explicit reasoning choice survives for every model of the route');
      assert.equal(route.displayName, 'fixture-router', 'the route is titled with the name the router publishes for itself');
      assert.equal(route.maxConcurrency, offered.length, 'route concurrency is the slots of every distinct model the router offers');
      // The route record describes the router as a whole: it names no service, carries no
      // picker label of its own, and one offline model never gates the route (§4).
      assert.equal(route.residentState.service, undefined, 'the route state names no service');
      assert.equal(route.residentState.label, undefined, 'the route state carries no picker label of its own');
      assert.equal(route.residentUnavailable, false, 'this router answers and admits requests in both configurations');
      assert.equal(route.residentState.status, 'available');
      assert.equal(route.residentState.reason, null);
      assert.equal(route.residentState.configuration, configuration);
      assert.equal(route.residentState.default, 'daytime', 'the document default answers a selection that names no configured model');
      // One model row per service the router offers — plus a stated row for the name these
      // settings carried before service IDs existed — and exactly one recorded state per
      // row (docs/llm-router-contract.md §4, §5). Titles are the fixture's published ones.
      const expectations = {
        daytime: { name: publishedTitle.daytime, status: 'available', reason: null, limits: 'current', nsfw: false,
          input: ['text', 'image'] },
        nighttime: nightOnline
          ? { name: `${publishedTitle.nighttime}${publishedNsfw.nighttime ? ' · NSFW' : ''}`, status: 'available', reason: null,
              limits: 'current', nsfw: true, input: ['text'] }
          : { name: `${publishedTitle.nighttime} — offline (${configuration})`, status: 'offline', reason: 'exclusive_configuration',
              limits: 'stale', nsfw: null },
        trial: trialOnline
          ? { name: publishedTitle.trial, status: 'available', reason: null, limits: 'current', nsfw: false, input: ['text'] }
          : { name: `${publishedTitle.trial} — offline (${configuration})`, status: 'offline', reason: 'exclusive_configuration',
              limits: 'stale', nsfw: null },
      };
      assert.deepEqual(route.models.map(row => row.id), Object.keys(expectations),
        'the route configures one row per service the router offers, in publication order');
      assert.ok(!route.models.some(row => row.id === COMPATIBILITY_ALIAS),
        'the reserved compatibility alias is not a service, so it is not kept as a model row (§3)');
      assert.deepEqual(Object.keys(states).sort(), route.models.map(row => row.id).sort(), 'every model row carries exactly one recorded state');
      assert.deepEqual(route.residentState.services, route.models.map(row => ({ service: row.id, status: states[row.id].status })),
        'the route record lists the same services as the rows');
      for (const [service, expected] of Object.entries(expectations)) {
        const row = rows[service];
        const state = states[service];
        assert.equal(row.name, expected.name, `${service}: the row carries the published title and exactly one state`);
        assert.equal(state.service, service, `${service}: a recorded state answers for its own model`);
        assert.equal(state.status, expected.status, `${service}: the state is the one the router publishes for this model`);
        assert.equal(state.label, expected.name, `${service}: the picker label is the row title`);
        assert.equal(state.configuration, configuration, `${service}: the active router configuration is recorded`);
        assert.equal(state.reason, expected.reason, `${service}: the state says why`);
        assert.equal(state.limits, expected.limits, `${service}: limits are ${expected.limits} for this model`);
        assert.equal(state.nsfw, expected.nsfw, `${service}: the nsfw flag is the one the router published`);
        if (expected.limits === 'current') {
          assert.deepEqual([...row.input].sort(), [...expected.input].sort(),
            `${service}: the modalities of the model that serves it, never a neighbour's`);
          assert.equal(row.contextWindow, servedBudget, `${service}: the published context window less its safety reserve`);
          assert.equal(row.maxTokens, null, `${service}: the published unrestricted output policy`);
          assert.deepEqual(row.reasoningEfforts, effortMap, `${service}: the published reasoning levels`);
          assert.doesNotMatch(row.name, / — /, `${service}: a model on offer carries its published title and no state`);
          assert.equal('message' in state, false, `${service}: a model on offer states no failure`);
        } else if (expected.stale) {
          assert.equal(row.contextWindow, expected.stale.contextWindow, `${service}: limits recorded earlier are kept`);
          assert.equal(row.maxTokens, expected.stale.maxTokens, `${service}: kept limits stay as they were recorded`);
          assert.deepEqual([...row.input].sort(), [...expected.stale.input].sort(), `${service}: kept modalities stay as recorded`);
        } else {
          assert.ok(!('input' in row) && !('contextWindow' in row),
            `${service}: a model nothing serves keeps no limits borrowed from another model`);
        }
        if (expected.status === 'offline') {
          assert.match(state.message, new RegExp(`^${escapeRegExp(publishedTitle[service])} is offline in router configuration `
            + `"${configuration}" \\(exclusive_configuration\\)`), `${service}: the failure names the model and its configuration`);
          assert.match(state.message, service === 'trial'
            ? /opt-in model: Harness never selects it and never moves a session off it/
            : /Select another model, or retry when/, `${service}: the advice is the one for this service`);
        }
      }
      // The opt-in service is discovered, shown and held, and never becomes a default.
      assert.equal(current['agent-default-model'].model === 'trial', false, 'the opt-in model is never the default');
      // §3: the reserved compatibility alias is not a service. These settings carried it as
      // a model row before service IDs, so it survives only as a row that states its own
      // state: never a selection, never the document default, never an offered model.
      assert.equal(current['agent-default-model'].model === COMPATIBILITY_ALIAS, false);
      assert.equal(route.residentState.default === COMPATIBILITY_ALIAS, false);
      assert.equal(route.residentState.services.some(entry => entry.service === COMPATIBILITY_ALIAS && entry.status !== 'unavailable'), false);
      // Contract §3: resident settings persist service IDs only, never canonical IDs.
      const persisted = JSON.stringify({ selection: current['agent-default-model'], route });
      assert.doesNotMatch(persisted, /fixture-(?:daytime|nighttime|trial)-q/, 'a canonical model ID was persisted');
      const migratedPath = path.join(runtime, 'profiles/web/cordis.patch.yml');
      assert.equal((await fs.stat(migratedPath)).mode & 0o777, 0o600);
      await fs.access(path.join(runtime, '.container-settings-v1.json'));
      assert.equal((await fs.readdir(runtime)).some(name => name.includes('before-residents') || name.includes('.resident-')), false);
      const before = JSON.stringify(current);
      await new Promise(resolve => setTimeout(resolve, 500));
      assert.equal(JSON.stringify(await readSettings(settingsPath)), before);
      console.log('Real Harness entrypoint migrated the one-route-per-service providers onto the catalog route before agent activation; published titles, per-model states, null limits and explicit preferences verified.');
      lastError = undefined;
      break;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (lastError) throw lastError;
  await authenticate();
  if (daytimeOnly) {
    const result = await exec(process.execPath, ['/opt/dsh-build/verify-resident-availability.mjs'], {
      env: { ...process.env, DSH_PROFILE_ROOT: path.join(runtime, 'profiles/web'), DSH_VERIFY_URL: webBase,
        DSH_BOOT_TOKEN: (await fs.readFile(path.join(runtime, 'web-launch-token'), 'utf8')).trim(),
        DSH_AVAILABILITY_FIXTURE: baseURL.replace(/\/v1$/, '') },
      timeout: 240000,
    });
    process.stdout.write(result.stdout);
  }
  if (!daytimeOnly) await rpc('settings/update', { ns: 'agent-default-model', patch: { reasoningEffort: 'low' } });
  await rpc('settings/update', { ns: 'better-sidebar', patch: { tabsEnabled: { subagent: false, sidechat: true } } });
  const retained = await rpc('settings/describe');
  const model = retained.namespaces.find(row => row.ns === 'agent-default-model').value;
  const sidebar = retained.namespaces.find(row => row.ns === 'better-sidebar').value;
  if (daytimeOnly) assert.deepEqual(model, expectedDefault, 'Bedrock default is restored without adding reasoning preferences');
  else assert.equal(model.reasoningEffort, 'low');
  assert.deepEqual(sidebar.tabsEnabled, { subagent: false, sidechat: true });
  for (let restart = 0; restart < 2; restart++) {
    await stop();
    start();
    await authenticate();
    const actual = await rpc('settings/describe');
    assert.deepEqual(actual.namespaces.find(row => row.ns === 'agent-default-model').value, model);
    assert.deepEqual(actual.namespaces.find(row => row.ns === 'better-sidebar').value, sidebar);
    const migrated = await readSettings(settingsPath);
    assert.equal(migrated['llm-pi-ai'].providers['local-ollama'].apiKeyEnv, 'STARTUP_FIXTURE_KEY');
    for (const retired of Object.keys(RETIRED_ROUTES)) {
      assert.equal(migrated['llm-pi-ai'].providers[retired], undefined, `${retired} stayed retired across the restart`);
    }
    assert.deepEqual(migrated['llm-pi-ai'].providers['local-ollama'].models.map(row => row.id),
      catalogRows, 'the catalog route kept its model rows across the restart');
    const inventory = await rpc('pluginInventory/list');
    const token = inventory.entries.find(row => row.moduleName === '@zoytown/dsh-token');
    assert.notEqual(token?.enabled, true);
    assert.notEqual(token?.fiberPhase, 'active');
    assert.equal(await fs.readFile(tokenIndexPath, 'utf8'), tokenIndex, 'disabled Token index bytes');
    const tokenIndexAfter = await fs.stat(tokenIndexPath);
    assert.equal(tokenIndexAfter.mtimeMs, tokenIndexBefore.mtimeMs, 'disabled Token index was not rewritten');
    assert.equal(tokenIndexAfter.ino, tokenIndexBefore.ino, 'disabled Token index was not replaced');
  }
  console.log('Settings saved through the rc2 API, model choice, plugin preferences and credential references survived two complete entrypoint restarts; Token stayed unloaded and its index stayed unchanged.');
  // No automated path may select the opt-in model, and a router that serves the
  // daytime service never leaves a "not offered" line behind for it.
  assert.equal(inferenceRequests.includes('trial'), false, 'an opt-in model was selected without a human');
  assert.doesNotMatch(bootLog, /daytime: .*not offered by the router/, 'the daytime service is offered by this fixture configuration');

} catch (error) {
  // This isolated home contains synthetic settings only; strip launch URLs.
  const diagnostic = bootLog.split('\n').slice(-30).map(line => line.replace(/https?:\/\/\S+/g, '[endpoint]').replace(/fixture-only[^\s]*/g, '[fixture value]')).join('\n');
  throw new Error(`${error.message.replace(/https?:\/\/\S+/g, '[endpoint]').replace(/cookie:.*$/gim, 'cookie: [redacted]')}${diagnostic ? '\n' + diagnostic : ''}`);
} finally {
  await stop();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(parent, { recursive: true, force: true });
}
