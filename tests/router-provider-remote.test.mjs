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
import { fakeRouter, paired, solo, trio, draining, residentModel, legacySettings, settingsService, NIGHTTIME_MTP3_ID } from './fixtures/router-contract.mjs';
const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const contract = await loadRouterContract();
const { synchronizeRouterSettings, applyOperation, RouterWatch, ResidentDiscovery, routerClientName, ROUTER_PROVIDER,
  ROUTER_CONTRACT_HUB } = contract;
const CLIENT = routerClientName();
/** Every name a settings tree written before a router's catalog drove the model
 * list carries a row for. */
const RECORDED = ['local-active', 'qwen3.8-27b-abliterated-q6_k'];
/** The reserved compatibility alias of §3: never a name a row answers with. */
const RESERVED = 'local-active';
/** A name this fixture router never publishes, so never a model of its own: a
 * row for it would be a model of Harness's invention. It stays a row only while
 * the router is not answering at all, where nothing can be read (§7: the last
 * catalog, marked stale), and never survives a document that omits it. */
const REMEMBERED = ['qwen3.8-27b-abliterated-q6_k'];
const service = (state, mutations) => settingsService(state, mutations, applyOperation);
const providers = state => state['llm-pi-ai'].providers;
const route = state => providers(state)[ROUTER_PROVIDER];
const row = (state, model) => route(state).models.find(entry => entry.id === model);
const rowState = (state, model) => route(state).residentStates[model];
const canonical = /fixture-/;

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

test('startup migration writes one catalog route, takes limits from each serving model, and identifies itself', async t => {
  const router = await fakeRouter(t, paired());
  const remote = await remoteVerifier(t);
  const state = legacySettings(router.baseURL);
  const mutations = [];
  const { results, errors } = await synchronizeRouterSettings(service(state, mutations));
  assert.deepEqual(errors, []);
  // One route for one router: its model rows are exactly the services that router
  // publishes, in publication order — nothing this settings tree remembers.
  assert.deepEqual(route(state).models.map(entry => entry.id), ['daytime', 'nighttime']);
  assert.equal(row(state, 'daytime').contextWindow, 163840 - 1024);
  assert.equal(row(state, 'nighttime').contextWindow, 98304 - 1024);
  assert.deepEqual(row(state, 'daytime').input, ['text', 'image']);
  assert.deepEqual(row(state, 'nighttime').input, ['text'], 'each row takes the modalities of the model that serves it');
  assert.equal(row(state, 'daytime').maxTokens, null);
  assert.equal(row(state, 'nighttime').name, 'Qwen3.8 27B Abliterated Q6_K (96K)',
    'the published title verbatim: no state, no badge, no qualifier appended to a name');
  assert.equal(route(state).maxConcurrency, 2, 'slots summed over the distinct models the route offers');
  assert.equal(route(state).apiKeyEnv, 'UNCHANGED_CREDENTIAL_REFERENCE', 'a credential reference is never overwritten');
  assert.equal(row(state, REMEMBERED[0]), undefined,
    'a name this router does not publish is not a model, so it has no row of its own');
  assert.equal(rowState(state, REMEMBERED[0]), undefined,
    'and with no row there is no state recorded for a model the router does not offer');
  assert.equal(route(state).headers['X-Client-Name'], CLIENT);
  assert.equal(results.get(ROUTER_PROVIDER).route.status, 'available');
  assert.deepEqual(Object.keys(providers(state)).sort(), ['custom', ROUTER_PROVIDER],
    'the one-route-per-service routes are retired once the catalog route lists their service');
  assert.deepEqual(state['agent-default-model'], { provider: ROUTER_PROVIDER, model: 'daytime', reasoningEffort: 'off', custom: 'retain' });
  assert.deepEqual(state['custom-setting'], { preserved: true });
  assert.doesNotMatch(JSON.stringify(route(state)), canonical, 'nothing persisted addresses a canonical model ID');
  assert.ok(router.state.clientNames.every(name => name === CLIENT), 'every discovery fetch sends X-Client-Name');
  const count = mutations.length;
  await synchronizeRouterSettings(service(state, mutations));
  assert.equal(mutations.length, count, 'migration is idempotent');
  await verifyConfiguredRoutes(state, { browser: true });
  assert.match((await remote(state)).stdout, /Verified/);
  // A browser session runs on the model its settings selected, and that model has
  // to carry vision: a text-only model is a failure, not a silent downgrade.
  state['agent-default-model'] = { provider: ROUTER_PROVIDER, model: 'nighttime' };
  await assert.rejects(verifyConfiguredRoutes(state, { browser: true }), /vision/);
});

test('the opt-in trial is offered when its router publishes it, and held when it stops', async t => {
  const router = await fakeRouter(t, trio());
  const state = legacySettings(router.baseURL);
  await synchronizeRouterSettings(service(state));
  assert.deepEqual(route(state).models.map(entry => entry.id), ['daytime', 'nighttime', 'trial']);
  assert.equal(row(state, 'trial').contextWindow, 163840 - 1024);
  assert.deepEqual(row(state, 'trial').input, ['text'], 'the trial takes its own model’s modalities, not another service’s');
  assert.equal(rowState(state, 'trial').status, 'available', 'being offered only to a human is a property of the service, not of its state');
  assert.equal(route(state).residentState.default, 'daytime', 'an opt-in model is never what a session falls into');
  assert.equal(state['agent-default-model'].model, 'daytime', 'migration never selects the opt-in model');
  const rows = await verifyConfiguredRoutes(state);
  assert.equal(rows.find(entry => entry.service === 'trial').optIn, true);
  const listed = await residentClientExpectations(state);
  const trial = listed.find(entry => entry.model === 'trial');
  assert.equal(trial.optIn, true, 'the picker shows it and marks that only a human may select it');
  assert.equal(trial.available, true);
  // A router that stops publishing the name takes the model away with it: the row
  // is gone, not held under a name the document never mentions. The list of
  // models is the router's to publish, and one Harness kept back would be its own.
  router.publish(paired());
  await synchronizeRouterSettings(service(state));
  assert.deepEqual(route(state).models.map(entry => entry.id), ['daytime', 'nighttime'],
    'a name the document stops mentioning has no row of its own');
  assert.equal(row(state, 'trial'), undefined, 'the withdrawn opt-in model is not offered as a model');
  assert.equal(rowState(state, 'trial'), undefined, 'and no state is recorded for a model that is not on offer');
  const notices = [];
  await verifyConfiguredRoutes(state, { log: notice => notices.push(notice) });
  assert.doesNotMatch(notices.join('\n'), /trial/, 'nothing is reported about a model this router no longer publishes');
  // The opt-in notice the verifier keeps is the other case: a service this router
  // does publish, and whose row discovery has not written yet.
  router.publish(trio({ models: [residentModel(), residentModel({ service: 'nighttime' }),
    residentModel({ service: 'trial', available: false })] }));
  const caught = [];
  await verifyConfiguredRoutes(state, { log: notice => caught.push(notice) });
  assert.match(caught.join('\n'),
    /local-ollama\/trial: unavailable \(backend unavailable\); skipped \(opt-in service: discovery creates the row when the router offers it\)/);
  await synchronizeRouterSettings(service(state));
  assert.equal(rowState(state, 'trial').status, 'unavailable', 'discovery then writes the row, with its own state');
  assert.equal(row(state, 'trial').name, 'Qwen3.8 Flash-Next (Strata trial) (160K)',
    'titled with the title the router published for it, even while it cannot serve');
  assert.equal(state['agent-default-model'].model, 'daytime', 'nothing moves a session onto or off the opt-in model');
});

test('solo configuration: Nighttime offline with the configuration ID never blocks Daytime or verification', async t => {
  const router = await fakeRouter(t, solo());
  const remote = await remoteVerifier(t);
  const state = legacySettings(router.baseURL);
  const bedrock = { api: 'bedrock-converse-stream', region: 'us-west-2', apiKeyEnv: 'BEDROCK_SECRET' };
  providers(state)['amazon-bedrock'] = bedrock;
  state['agent-default-model'] = { provider: 'amazon-bedrock', model: 'external-model', reasoningEffort: 'high' };
  await synchronizeRouterSettings(service(state));
  assert.equal(row(state, 'nighttime').name, 'Qwen3.8 27B Abliterated Q6_K (96K)',
    'a service the active configuration stops is titled by its own published display_name, with nothing composed on it');
  assert.equal(rowState(state, 'nighttime').status, 'offline');
  assert.equal(rowState(state, 'nighttime').configuration, 'flash-next-solo-128k');
  assert.equal(rowState(state, 'nighttime').limits, 'stale');
  assert.match(rowState(state, 'nighttime').message, /^Qwen3\.8 27B Abliterated Q6_K \(96K\) is offline in router configuration "flash-next-solo-128k"/,
    'the configuration it is offline in is stated in the message, not in the name');
  assert.equal(route(state).residentUnavailable, false, 'the route answers; only this model cannot serve');
  assert.equal(route(state).residentState.status, 'available');
  assert.equal(row(state, 'daytime').contextWindow, 131072 - 1024);
  assert.deepEqual(providers(state)['amazon-bedrock'], bedrock, 'an external provider is not a router and is left alone');
  assert.deepEqual(state['agent-default-model'], { provider: 'amazon-bedrock', model: 'external-model', reasoningEffort: 'high' });
  const notices = [];
  const rows = await verifyConfiguredRoutes(state, { log: notice => notices.push(notice) });
  assert.deepEqual(rows.map(entry => entry.status), ['available', 'offline']);
  assert.match(notices.join('\n'),
    /local-ollama\/nighttime: offline \(flash-next-solo-128k\); skipped — the router's current configuration is not a Harness failure\./);
  const output = await remote(state);
  assert.match(output.stdout, /local-ollama\/nighttime: offline \(flash-next-solo-128k\); skipped/);
  assert.doesNotMatch(output.stdout, /qwen3\.8-27b-abliterated-q6_k/,
    'a name this router publishes no service for is not even offered, so there is nothing to report about it');
  assert.match(output.stdout, /Verified/);
  const expected = await residentClientExpectations(state);
  assert.deepEqual(expected.map(entry => [entry.model, entry.available, entry.optIn ?? false]),
    [['daytime', true, false], ['nighttime', false, false]]);
  assert.equal(expected[1].name, 'Qwen3.8 27B Abliterated Q6_K (96K)',
    'the picker shows the router’s own title for a model it cannot serve, and nothing else');
  assert.equal(expected[0].contextWindow, 131072 - 1024);
});

for (const [label, damage] of [
  ['unavailable', night => { night.available = false; }],
  ['incomplete', night => { night.metadata.reasoning = { ...night.metadata.reasoning, efforts: {}, aliases: {}, per_effort: {} }; }],
]) {
  test(`Nighttime ${label}: recorded on its own while Daytime limits still update`, async t => {
    const router = await fakeRouter(t, paired());
    const state = legacySettings(router.baseURL);
    await synchronizeRouterSettings(service(state));
    const before = structuredClone(row(state, 'nighttime'));
    const damaged = paired({ models: [residentModel({ contextWindow: 196608 }), residentModel({ service: 'nighttime' })] });
    damage(damaged.models[1]);
    router.publish(damaged);
    const { errors } = await synchronizeRouterSettings(service(state));
    assert.deepEqual(errors, []);
    assert.equal(row(state, 'daytime').contextWindow, 196608 - 1024, 'one model is never frozen by another');
    const night = row(state, 'nighttime');
    assert.equal(night.contextWindow, before.contextWindow, 'its last limits are retained');
    assert.deepEqual(night.reasoningEfforts, before.reasoningEfforts, 'and its effort mapping, marked stale rather than dropped');
    assert.equal(night.name, before.name, 'a name a model still answers for keeps the title the router publishes for it');
    assert.equal(rowState(state, 'nighttime').label, 'Qwen3.8 27B Abliterated Q6_K (96K)',
      'the label is the published title unchanged; the state is a separate field, never a word in the name');
    assert.match(rowState(state, 'nighttime').message, /^Qwen3\.8 27B Abliterated Q6_K \(96K\) is unavailable/,
      'the state is stated in the message a person reads instead, under the published title');
    assert.match(rowState(state, 'nighttime').message, new RegExp(label));
    assert.equal(rowState(state, 'nighttime').status, label);
    assert.equal(rowState(state, 'nighttime').limits, 'stale');
    assert.equal(route(state).residentUnavailable, false, 'the router answers; only this model is blocked');
    const listed = await residentClientExpectations(state, { live: false });
    assert.deepEqual(listed.map(entry => [entry.model, entry.available]),
      [['daytime', true], ['nighttime', false]],
      'one model is never blocked by another, and a name nobody publishes is not a model at all');
    assert.equal(listed[1].status, label);
    assert.equal(listed[1].name, rowState(state, 'nighttime').label, 'the listing shows the router’s own title for the model');
    assert.doesNotMatch(listed[1].name, new RegExp(label), 'and carries no state word of its own');
  });
}

test('router draining: every model waits (not blocked), limits stay stale, verification passes', async t => {
  const router = await fakeRouter(t, paired());
  const state = legacySettings(router.baseURL);
  await synchronizeRouterSettings(service(state));
  const before = structuredClone(route(state).models);
  router.publish(draining());
  await synchronizeRouterSettings(service(state));
  assert.equal(route(state).residentState.status, 'switching');
  assert.equal(route(state).residentUnavailable, false, 'a draining router makes requests wait rather than fail');
  assert.deepEqual(route(state).residentState.services.map(entry => [entry.service, entry.status]),
    [['daytime', 'switching'], ['nighttime', 'switching']]);
  for (const [model, title] of [['daytime', 'Qwen3.8 27B Q6_K (160K)'], ['nighttime', 'Qwen3.8 27B Abliterated Q6_K (96K)']]) {
    assert.equal(rowState(state, model).label, title, 'a drain is a state, never a word added to the router’s own title');
    assert.match(rowState(state, model).message, /wait and retry without changing models/);
  }
  for (const model of ['daytime', 'nighttime']) {
    assert.deepEqual(row(state, model), before.find(entry => entry.id === model), `a drain changes no limits of ${model}`);
  }
  assert.deepEqual(route(state).models.map(entry => entry.id), before.map(entry => entry.id),
    'and a drain adds no row and takes none away: only the document’s list of models does that');
});

test('router unreachable at startup: stored settings are kept, every recorded model is unavailable, discovery recovers', async t => {
  const router = await fakeRouter(t, paired());
  const state = legacySettings(router.baseURL);
  const stored = structuredClone(route(state).models);
  router.unreachable();
  const failures = [];
  const { errors, results } = await synchronizeRouterSettings(service(state), { onFetchError: (_base, error) => failures.push(error) });
  assert.deepEqual(errors, [], 'an unreachable router is not a startup failure');
  assert.equal(failures.length, 1);
  assert.equal(results.get(ROUTER_PROVIDER).route.reason, 'router unreachable');
  assert.equal(route(state).residentUnavailable, true, 'the route itself is what is not answering');
  assert.equal(route(state).residentState.status, 'unavailable');
  // The reserved compatibility alias is not a service (§3), so it is not a model
  // row even while the router is down: a name nobody can confirm is dropped rather
  // than kept as a row that claims a state it cannot have.
  const recorded = RECORDED.filter(id => id !== RESERVED);
  assert.deepEqual(route(state).models.map(entry => entry.id), recorded,
    'nothing can be read, so the route keeps exactly the service names its settings already carry');
  assert.equal(row(state, RESERVED), undefined, 'the reserved alias is never a model row');
  for (const name of recorded) {
    assert.equal(rowState(state, name).reason, 'router unreachable', name);
    assert.match(rowState(state, name).message, /router is unreachable/, name);
  }
  // The one name left standing was inherited from a route being retired, and no
  // router ever published limits for it here: an unreachable router invents none,
  // so the row states its state and carries no limits until a document arrives.
  assert.equal(row(state, recorded.at(-1)).contextWindow, undefined, 'unpublished limits are not invented');
  assert.equal(rowState(state, recorded.at(-1)).limits, 'stale', 'the row says its limits are not the router\'s');
  assert.equal(row(state, recorded.at(-1)).name, recorded.at(-1),
    'and a remembered name the router never titled keeps its own name, with no state word written into it');
  router.reachable();
  await synchronizeRouterSettings(service(state));
  assert.equal(route(state).residentState.status, 'available');
  assert.equal(route(state).residentUnavailable, false);
  assert.deepEqual(route(state).models.map(entry => entry.id), ['daytime', 'nighttime'],
    'the published names return, and the name that could not be confirmed is not taken back as a model of its own');
});

test('a new canonical ID behind nighttime between revisions keeps it available with nothing canonical persisted', async t => {
  const router = await fakeRouter(t, paired());
  const state = legacySettings(router.baseURL);
  await synchronizeRouterSettings(service(state));
  router.publish(paired({ models: [residentModel(), residentModel({ service: 'nighttime', id: NIGHTTIME_MTP3_ID, contextWindow: 131072 })] }));
  await synchronizeRouterSettings(service(state));
  assert.equal(rowState(state, 'nighttime').status, 'available');
  assert.equal(row(state, 'nighttime').contextWindow, 131072 - 1024);
  assert.doesNotMatch(JSON.stringify(state), /fixture-nighttime|mtp3/);
  await verifyConfiguredRoutes(state);
});

test('the live verifier rejects stale limits, titles, states, identity and an unpublished model', async t => {
  const router = await fakeRouter(t, paired());
  const remote = await remoteVerifier(t);
  const state = legacySettings(router.baseURL);
  await synchronizeRouterSettings(service(state));
  const saved = structuredClone(route(state));
  assert.deepEqual(saved.models.map(entry => entry.id), ['daytime', 'nighttime']);
  for (const [mutate, pattern] of [
    [own => { own.models.find(entry => entry.id === 'daytime').contextWindow = 131072; }, /context is not synchronized/],
    [own => { own.models.find(entry => entry.id === 'daytime').maxTokens = 1024; }, /output policy is not synchronized/],
    [own => { own.models.find(entry => entry.id === 'nighttime').input = ['text', 'image']; }, /modalities are not synchronized/],
    [own => { delete own.models.find(entry => entry.id === 'daytime').reasoningEfforts.medium; }, /effort mapping is not synchronized/],
    [own => { own.models.find(entry => entry.id === 'daytime').name = 'Qwen3.8 27B Q6_K'; }, /display name is not the title the router publishes/],
    [own => { own.residentStates.daytime.label = 'Qwen3.8 27B Q6_K'; }, /picker label is not synchronized/],
    [own => { own.residentStates.nighttime.status = 'unavailable'; }, /state is not synchronized \(router reports available\)/],
    [own => { own.models = own.models.filter(entry => entry.id !== 'daytime'); },
      /local-ollama\/daytime: the router publishes it but the route configures no such model; discovery has not written it/],
    [own => { own.models.find(entry => entry.id === 'daytime').id = 'daytime-legacy'; },
      /local-ollama\/daytime-legacy: the route offers a model the router publishes no service for/,
      'a row renamed away from the service the router publishes is its own model, not a stale name we wait for'],
    [own => { own.models.find(entry => entry.id === 'nighttime').id = RESERVED; },
      /local-ollama\/local-active: the route offers a model the router publishes no service for/,
      'a row kept for an alias is a model of the route that must answer for itself, not an opt-out'],
    [own => { own.models.push({ id: 'qwen3.8-27b-abliterated', name: 'A model of our own' }); },
      /local-ollama\/qwen3\.8-27b-abliterated: the route offers a model the router publishes no service for/,
      'a row for a name the document never publishes is refused, whatever state is recorded on it'],
    [own => { own.maxConcurrency = 3; }, /concurrency is not the slots of the models it offers \(offered 2\)/],
    [own => { delete own.headers; }, /does not identify itself with X-Client-Name/],
    [own => { own.displayName = 'Ollama'; }, /is not titled with the name the router publishes/],
    [own => { own.residentUnavailable = true; }, /route availability is not synchronized \(router reports available\)/],
    [own => { own.residentState = { ...own.residentState, status: 'switching' }; }, /route state is not synchronized/],
    [own => { own.models = []; }, /configures no models/],
  ]) {
    providers(state)[ROUTER_PROVIDER] = structuredClone(saved);
    mutate(providers(state)[ROUTER_PROVIDER]);
    await assert.rejects(verifyConfiguredRoutes(state), pattern);
    await assert.rejects(remote(state), error => error.code === 22 && pattern.test(error.stderr));
  }
  // A route written by a one-route-per-service release is a second answer to the
  // same router: discovery deletes it, and verification refuses to accept one.
  providers(state)[ROUTER_PROVIDER] = structuredClone(saved);
  providers(state)['local-everyday'] = structuredClone(saved);
  await assert.rejects(verifyConfiguredRoutes(state), /provider local-everyday is retired: one route per router carries its catalog/);
  await assert.rejects(remote(state), error => error.code === 22 && /is retired/.test(error.stderr));
  providers(state)[ROUTER_PROVIDER] = structuredClone(saved);
  delete providers(state)['local-everyday'];
  await verifyConfiguredRoutes(state);
  const output = await remote(state);
  assert.match(output.stdout, /Verified/);
});

test('a router that has stopped answering is verified as the state the route records', async t => {
  const router = await fakeRouter(t, paired());
  const remote = await remoteVerifier(t);
  const state = legacySettings(router.baseURL);
  await synchronizeRouterSettings(service(state));
  await verifyConfiguredRoutes(state);
  router.unreachable();
  await synchronizeRouterSettings(service(state));
  // §5 and §7: with the router silent there is no document to compare against,
  // and no fallback to invent. The route says the router is down and every model
  // answers for itself as down; that is what verification has to confirm.
  const rows = await verifyConfiguredRoutes(state, { log: () => {} });
  assert.ok(rows.length > 1, JSON.stringify(rows));
  assert.ok(rows.every(row => row.status === 'unavailable' && /router not answering/.test(row.notice ?? '')),
    JSON.stringify(rows));
  const output = await remote(state);
  assert.match(output.stdout, /an unreachable router is a state, not a Harness failure/);
  // What does fail is settings that still offer a model the silent router cannot
  // serve: a row left standing at `available` is a Harness desync, not the
  // router's configuration.
  providers(state)[ROUTER_PROVIDER].residentStates.daytime = { ...rowState(state, 'daytime'), status: 'available' };
  await assert.rejects(verifyConfiguredRoutes(state),
    /local-ollama\/daytime: the router is not answering but the model still records available/);
  await assert.rejects(remote(state), error => error.code === 22 && /still records available/.test(error.stderr));
});

test('rollback verification skips identity checks, and a router this Harness does not follow is reported', async t => {
  const router = await fakeRouter(t, solo());
  const state = legacySettings(router.baseURL);
  await synchronizeRouterSettings(service(state));
  // Settings written by a release that did not identify itself and titled models
  // itself: identity is what rollback cannot restore, so it is not demanded.
  const saved = structuredClone(route(state));
  delete route(state).headers;
  await assert.rejects(verifyConfiguredRoutes(state), /does not identify itself with X-Client-Name/);
  const rows = await verifyConfiguredRoutes(state, { allowLegacyIds: true, primaryBrowser: true });
  assert.deepEqual(rows.map(entry => [entry.service, entry.status]),
    [['daytime', 'available'], ['nighttime', 'offline']],
    'the route carries exactly the services the router publishes: the stopped one with its own state');
  // A second router the plugin follows without a route yet is the owner's next
  // discovery, not a failed verification.
  providers(state)[ROUTER_PROVIDER] = saved;
  state['router-model-discovery'] = { providers: [ROUTER_PROVIDER, 'second-router'] };
  const notices = [];
  await verifyConfiguredRoutes(state, { log: notice => notices.push(notice) });
  assert.match(notices.join('\n'), /second-router: no route is configured; skipped/);
  await assert.rejects(verifyConfiguredRoutes({ ...state, ['llm-pi-ai']: { providers: {} } }), /missing local-ollama provider/);
});

test('a concurrent edit to the route is never overwritten; the catalog still converges', async t => {
  const router = await fakeRouter(t, paired());
  const state = legacySettings(router.baseURL);
  const settings = service(state);
  const describe = settings.describe;
  let reads = 0;
  settings.describe = () => {
    if (++reads === 3) providers(state)[ROUTER_PROVIDER].apiKeyEnv = 'NEW_CREDENTIAL_REFERENCE';
    return describe();
  };
  const { errors } = await synchronizeRouterSettings(settings);
  assert.match(errors.map(row => `${row.provider}: ${row.error.message}`).join('\n'),
    /local-ollama: router settings changed during discovery/);
  assert.equal(route(state).apiKeyEnv, 'NEW_CREDENTIAL_REFERENCE');
  await synchronizeRouterSettings(service(state));
  assert.deepEqual(route(state).models.map(entry => entry.id), ['daytime', 'nighttime'],
    'the next refresh writes the catalog the router publishes; the alias it cannot confirm is not a model (1.2 §3)');
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
  const stateOf = model => rowState(state, model);
  await eventually(() => assert.equal(stateOf('nighttime')?.status, 'available'), 'startup sync');
  router.publish(solo());
  await eventually(() => assert.equal(stateOf('nighttime').status, 'offline'), 'a pushed revision re-syncs immediately');
  assert.ok(logs.includes('router-model-discovery: nighttime: available → offline (flash-next-solo-128k)'), logs.join('\n'));
  assert.ok(describes > 0, 'settings/document-updated is flushed for open pickers');
  router.publish(paired());
  await eventually(() => assert.equal(stateOf('nighttime').status, 'available'), 'Nighttime becomes selectable again with no action');
  assert.equal(route(state).residentUnavailable, false);
  // The document can lag: a SERVICE_OFFLINE answer marks that model offline at once.
  const hub = globalThis[ROUTER_CONTRACT_HUB];
  hub.report(ROUTER_PROVIDER, { model: 'nighttime', code: 'SERVICE_OFFLINE',
    message: 'X is offline in runtime configuration "flash-next-solo-128k" (exclusive_configuration).' });
  await eventually(() => assert.equal(stateOf('nighttime').status, 'offline'), 'SERVICE_OFFLINE holds the model offline');
  assert.equal(stateOf('nighttime').configuration, 'flash-next-solo-128k');
  assert.equal(rowState(state, 'daytime').status, 'available', 'the hold names one model, never the route');
  router.publish(solo());
  await eventually(() => assert.equal(stateOf('nighttime').reason, 'exclusive_configuration'), 'the document supersedes the hold');
  router.publish(paired());
  await eventually(() => assert.equal(stateOf('nighttime').status, 'available'), 'returns again');
  // BACKEND_UNAVAILABLE after the bounded provider retries marks it unavailable.
  for (let attempt = 0; attempt < 3; attempt += 1) hub.report(ROUTER_PROVIDER, { model: 'nighttime', code: 'BACKEND_UNAVAILABLE' });
  await eventually(() => assert.equal(stateOf('nighttime').status, 'unavailable'), 'repeated backend failures mark it unavailable');
  assert.equal(rowState(state, 'daytime').status, 'available', 'one model answers for itself');
  router.publish(paired());
  await eventually(() => assert.equal(stateOf('nighttime').status, 'available'), 'a new revision clears the hold');
  // Router gone: the route is unavailable; back: recovered automatically.
  router.unreachable();
  await eventually(() => assert.equal(route(state).residentState.reason, 'router unreachable'), 'unreachable', 5000);
  assert.ok(logs.some(line => line === 'router-model-discovery: daytime: available → unavailable (router unreachable)'), logs.join('\n'));
  router.reachable();
  await eventually(() => assert.equal(route(state).residentState.status, 'available'), 'recovers', 5000);
});

test('a pre-contract router without /v1/router/capabilities keeps its models usable from the model listing', async t => {
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
  const before = structuredClone(route(state).models);
  const { errors } = await synchronizeRouterSettings(service(state));
  assert.deepEqual(errors, []);
  assert.equal(route(state).residentUnavailable, false);
  assert.equal(route(state).residentState.status, 'available');
  // The listing answers for one service under a name, which is the only row it
  // gets: a pre-contract router names its models too, and names nothing else.
  assert.deepEqual(route(state).models.map(entry => entry.id), ['daytime']);
  assert.equal(row(state, 'daytime').contextWindow, undefined, 'limits a pre-contract router does not publish are not invented');
  assert.equal(row(state, REMEMBERED[0]), undefined, 'a name this router does not list is not one of its models either');
  assert.equal(before[0].contextWindow, 262144, 'the settings tree is read as it stands before this route is written');
  assert.equal(rowState(state, 'daytime').limits, 'stored', 'a usable model without published limits is marked as running on stored limits');
  assert.ok(seen.some(([url, name]) => url === '/v1/models' && name === CLIENT));
  const notices = [];
  const rows = await verifyConfiguredRoutes(state, { log: notice => notices.push(notice) });
  assert.deepEqual(rows.map(entry => entry.status), ['available']);
  assert.match(notices.join('\n'), /local-ollama\/daytime: served by a pre-contract router without published limits; stored limits kept/);
  assert.doesNotMatch(notices.join('\n'), /qwen3\.8-27b-abliterated-q6_k/, 'nothing is reported about a model it does not offer');
});
