import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fakeRouter, paired, solo, strata, trio } from './fixtures/router-contract.mjs';

const runtime = process.env.DSH_RUNTIME_ROOT ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh';
let YAML;
try { YAML = createRequire(`${runtime}/package.json`)('yaml'); } catch (error) {
  if (process.env.DSH_TEST_HARNESS === '1') throw error;
}
const exec = promisify(execFile);
const script = new URL('../scripts/migrate-resident-models.mjs', import.meta.url).pathname;
/** A selection saved before a catalog drove the model list names the model, not the service. */
const canonical = { 'local-ollama-256k': 'local-active', 'local-everyday': 'qwen3.8-27b-abliterated-q6_k', 'local-trial': 'qwen3.8-flash-next-trial' };

/**
 * Settings as a deployment that has never read a router catalog recorded them: a
 * route for each service it could select, a route for an expansion it no longer
 * runs, and saved selections that name a model rather than a service. The
 * catalog route adopts the services of the routes it supersedes and keeps the
 * state of every one of them; the numbers a router published for another route
 * are not carried over, because they described a route that no longer exists.
 */
async function fixture(t, baseURL = 'http://127.0.0.1:1/v1') {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'resident-migration-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const settings = YAML.parse(await fs.readFile(new URL('../config/settings.yaml', import.meta.url), 'utf8'));
  const route = settings['llm-pi-ai'].providers['local-ollama'];
  route.baseURL = baseURL;
  for (const [provider, service] of [['local-everyday', 'nighttime'], ['local-trial', 'trial'], ['local-ollama-256k', canonical['local-ollama-256k']]]) {
    const models = [{ ...route.models[0], id: service, name: service }];
    settings['llm-pi-ai'].providers[provider] = { ...structuredClone(route), displayName: service, models };
  }
  settings['agent-default-model'] = { provider: 'local-ollama-256k', model: canonical['local-ollama-256k'], reasoningEffort: 'off' };
  settings['compaction-basic'] = { modelPolicies: [
    { provider: 'local-everyday', model: canonical['local-everyday'], thresholdRatio: 0.7 },
    { provider: 'local-trial', model: canonical['local-trial'], thresholdRatio: 0.7 },
    { provider: 'amazon-bedrock', model: 'external', thresholdRatio: 0.8 },
  ] };
  const file = path.join(home, 'profiles/web/cordis.patch.yml');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, YAML.stringify(Object.entries(settings).map(([id, config]) => ({ id, config }))), { mode: 0o600 });
  return { home, file };
}
const launch = (home, env = {}) => exec(process.execPath, [script, '--startup', `${home}/settings.yaml`], {
  env: { ...process.env, DSH_RUNTIME_ROOT: runtime, HARNESS_CLIENT_INSTANCE: 'migration-fixture', ...env },
});
const rows = async file => YAML.parse(await fs.readFile(file, 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
const config = (parsed, id) => parsed.find(row => row.id === id)?.config;
const row = (provider, service) => provider.models.find(model => model.id === service);
/** One line of the startup summary, which states a service exactly as it is recorded. */
const line = (stdout, service) => stdout.split('\n').find(entry => entry.startsWith(`${service}:`));

test('router unreachable at startup: exit 0, stored limits kept, every service unavailable, IDs migrated', { skip: !YAML }, async t => {
  const { home, file } = await fixture(t);
  const before = config(await rows(file), 'llm-pi-ai').providers;
  const stored = before['local-ollama'];
  const result = await launch(home);
  assert.match(result.stdout, /Router discovery is unavailable at startup/);
  assert.match(result.stdout, /^daytime: unavailable \(router unreachable\)$/m);
  assert.match(result.stdout, /^trial: unavailable \(router unreachable\) \[opt-in service; never selected automatically\]$/m);
  const providers = config(await rows(file), 'llm-pi-ai').providers;
  assert.deepEqual(Object.keys(providers), ['local-ollama'], "one route per router; its model rows are that router's catalog");
  const catalog = providers['local-ollama'];
  assert.equal(catalog.residentUnavailable, true);
  assert.equal(catalog.residentState.reason, 'router unreachable');
  assert.equal(catalog.headers['X-Client-Name'], 'deepseek-harness/migration-fixture');
  // Nothing answers the router, so every recorded service keeps a row and its
  // own stated failure rather than vanishing (§5), and no limits are invented
  // for a service this route never answered before.
  assert.deepEqual(catalog.models.map(model => model.id), ['daytime', 'nighttime', 'trial']);
  assert.equal(row(catalog, 'daytime').contextWindow, row(stored, 'daytime').contextWindow, 'the stored budget of the surviving route survives');
  for (const service of ['nighttime', 'trial']) {
    assert.equal(row(catalog, service).contextWindow, undefined, `${service} is given limits no router published for it`);
  }
  for (const service of ['daytime', 'nighttime', 'trial']) {
    const state = catalog.residentStates[service];
    assert.equal(state.status, 'unavailable');
    assert.equal(state.service, service);
    assert.equal(state.reason, 'router unreachable');
    assert.equal(state.limits, 'stale');
  }
  // An opt-in service says so in its own words and names no other model.
  assert.match(catalog.residentStates.trial.message, /opt-in model.*never moves a session off it/s);
  assert.doesNotMatch(catalog.residentStates.daytime.message, /opt-in/);
  // A saved selection of a route the catalog supersedes names the catalog route
  // and the service that route used to answer.
  assert.deepEqual(config(await rows(file), 'agent-default-model'), { provider: 'local-ollama', model: 'daytime', reasoningEffort: 'off' });
  assert.deepEqual(config(await rows(file), 'compaction-basic').modelPolicies.map(entry => entry.provider),
    ['local-ollama', 'local-ollama', 'amazon-bedrock']);
  assert.deepEqual(config(await rows(file), 'compaction-basic').modelPolicies.map(entry => entry.model), ['nighttime', 'trial', 'external']);
  assert.deepEqual(config(await rows(file), 'compaction-basic').modelPolicies.map(entry => entry.thresholdRatio), [0.7, 0.7, 0.8]);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /local-active|qwen3\.8|256k/, 'nothing persisted refers to a route or model ID the catalog replaced');
});

test('router HTTP errors are router state, not startup failures', { skip: !YAML }, async t => {
  const router = await fakeRouter(t, paired());
  router.state.respond = undefined;
  const { home, file } = await fixture(t, `${router.root}/broken/v1`);
  const result = await launch(home);
  assert.match(result.stdout, /unavailable at startup \(router capabilities returned HTTP 404/);
  const catalog = config(await rows(file), 'llm-pi-ai').providers['local-ollama'];
  assert.equal(catalog.residentUnavailable, true);
  assert.equal(catalog.residentState.status, 'unavailable');
});

test('invalid local settings are the only startup failure and leave the file unchanged', { skip: !YAML }, async t => {
  const { home, file } = await fixture(t);
  const parsed = await rows(file);
  delete config(parsed, 'llm-pi-ai').providers['local-ollama'];
  await fs.writeFile(file, YAML.stringify(parsed), { mode: 0o600 });
  const source = await fs.readFile(file, 'utf8');
  await assert.rejects(launch(home), error => error.code === 22 && /Missing the local-ollama router route/.test(error.stderr));
  assert.equal(await fs.readFile(file, 'utf8'), source);
  await fs.writeFile(file, 'llm-pi-ai: [unbalanced', { mode: 0o600 });
  await assert.rejects(launch(home), error => error.code === 22 && /Invalid settings YAML/.test(error.stderr));
});

for (const selection of ['amazon-bedrock', 'local-everyday', 'local-trial']) {
  test(`solo then paired configuration preserves ${selection}, expressions, comments and private state`, { skip: !YAML }, async t => {
    const router = await fakeRouter(t, solo());
    const { home, file } = await fixture(t, router.baseURL);
    const parsed = await rows(file);
    const providers = config(parsed, 'llm-pi-ai').providers;
    const external = { api: 'bedrock-converse-stream', apiKeyEnv: 'BEDROCK_PRIVATE_REFERENCE', headers: { Authorization: 'process.env.PRIVATE_FIXTURE' }, custom: { retain: true } };
    providers['amazon-bedrock'] = external;
    // A selection saved before a catalog drove the model list names the model
    // behind the route; an opt-in service is named only by the human who chose it.
    const model = selection === 'local-everyday' ? canonical['local-everyday'] : selection === 'local-trial' ? 'trial' : 'external';
    const saved = { provider: selection, model, reasoningEffort: 'high' };
    const expected = selection === 'amazon-bedrock' ? saved : { provider: 'local-ollama', model: selection === 'local-everyday' ? 'nighttime' : 'trial', reasoningEffort: 'high' };
    parsed.find(row => row.id === 'agent-default-model').config = saved;
    await fs.writeFile(file, YAML.stringify(parsed).replace('Authorization: process.env.PRIVATE_FIXTURE',
      'Authorization: !!js process.env.PRIVATE_FIXTURE # retain provider expression'), { mode: 0o600 });
    await fs.appendFile(file, '\n- id: unrelated-expression\n  config:\n    token: !!js process.env.PRIVATE_FIXTURE # retain expression and comment\n');
    const stat = await fs.stat(file);
    const session = `${home}/session.jsonl`;
    await fs.writeFile(session, 'unchanged session history');
    const result = await launch(home);
    assert.match(result.stdout, /^nighttime: offline \(flash-next-solo-128k\)$/m);
    // The trial is not offered by this configuration: recorded and announced, and
    // the update still exits 0.
    assert.match(result.stdout, /^trial: unavailable \(not offered by the router\) \[opt-in service; never selected automatically\]$/m);
    const text = await fs.readFile(file, 'utf8');
    assert.match(text, /!!js process.env.PRIVATE_FIXTURE # retain expression and comment/);
    assert.match(text, /Authorization: !!js process.env.PRIVATE_FIXTURE # retain provider expression/);
    const migrated = await rows(file);
    // A saved selection keeps its service: only the route that no longer exists
    // is replaced, and an explicit choice of an opt-in service is honored.
    assert.deepEqual(config(migrated, 'agent-default-model'), expected);
    const next = config(migrated, 'llm-pi-ai').providers;
    assert.deepEqual(next['amazon-bedrock'], external);
    const catalog = next['local-ollama'];
    assert.equal(row(catalog, 'daytime').contextWindow, 131072 - 1024);
    assert.equal(catalog.residentStates.nighttime.label, 'Qwen3.8 27B Abliterated Q6_K (96K) — offline (flash-next-solo-128k)');
    // The opt-in service is held with its reason and is never selectable: only a
    // human selection can put a session on it, and nothing moves one off it.
    assert.equal(catalog.residentStates.trial.status, 'unavailable');
    assert.equal(catalog.residentStates.trial.service, 'trial');
    assert.match(catalog.residentStates.trial.message, /opt-in model/);
    assert.equal(row(catalog, 'trial').id, 'trial');
    // Nothing puts a session on the opt-in service that a human did not put there.
    assert.equal(config(migrated, 'agent-default-model').model === 'trial', selection === 'local-trial');
    const after = await fs.stat(file);
    assert.equal(after.mode, stat.mode); assert.equal(after.uid, stat.uid); assert.equal(after.gid, stat.gid);
    assert.equal(await fs.readFile(session, 'utf8'), 'unchanged session history');
    const bytes = await fs.readFile(file, 'utf8');
    assert.match((await launch(home)).stdout, /already current/);
    assert.equal(await fs.readFile(file, 'utf8'), bytes, 'startup migration is idempotent');
    router.publish(paired());
    await launch(home);
    const restored = config(await rows(file), 'llm-pi-ai').providers['local-ollama'];
    assert.equal(restored.residentStates.nighttime.status, 'available');
    assert.equal(row(restored, 'nighttime').contextWindow, 98304 - 1024);
    // Nighttime returned; the trial is still not offered and stays held. A
    // human selected it, so it keeps the row and its reason and nothing moves.
    assert.equal(restored.residentStates.trial.status, 'unavailable');
    assert.equal(restored.residentStates.trial.reason, 'not offered by the router');
    assert.deepEqual(config(await rows(file), 'agent-default-model'), expected);
    assert.doesNotMatch(await fs.readFile(file, 'utf8'), /qwen3\.8|fixture-(?:day|night)time|local-active|256k/);
  });
}

// A saved selection that names the opt-in route by its model, not by its
// service, is not a human's choice of the opt-in service, and nothing moves a
// default onto it on its own. The migration says so and writes nothing; a
// person decides which service the deployment defaults to.
test('a default that would land on the opt-in service is refused, not guessed', { skip: !YAML }, async t => {
  const { home, file } = await fixture(t);
  const parsed = await rows(file);
  parsed.find(row => row.id === 'agent-default-model').config = { provider: 'local-trial', model: canonical['local-trial'], reasoningEffort: 'off' };
  await fs.writeFile(file, YAML.stringify(parsed), { mode: 0o600 });
  const source = await fs.readFile(file, 'utf8');
  await assert.rejects(launch(home), error => error.code === 22 && /refusing to move the default selection onto opt-in service trial/.test(error.stderr));
  assert.equal(await fs.readFile(file, 'utf8'), source);
});

// A router that offers the opt-in service: its row becomes real, but the
// selection stays exactly where the human left it.
test('the opt-in trial becomes available from its own metadata and disappears without a failed update', { skip: !YAML }, async t => {
  const router = await fakeRouter(t, trio());
  const { home, file } = await fixture(t, router.baseURL);
  const result = await launch(home);
  assert.match(line(result.stdout, 'trial'), /^trial: available$/);
  assert.doesNotMatch(result.stdout, /never selected automatically/);
  const catalog = config(await rows(file), 'llm-pi-ai').providers['local-ollama'];
  assert.deepEqual(catalog.models.map(model => model.id), ['daytime', 'nighttime', 'trial']);
  assert.equal(catalog.residentStates.trial.status, 'available');
  assert.equal(catalog.residentStates.trial.limits, 'current');
  // Its own serving metadata, and text-only: never another service's limits or modality.
  assert.equal(row(catalog, 'trial').contextWindow, 163840 - 1024);
  assert.deepEqual(row(catalog, 'trial').input, ['text']);
  assert.equal(row(catalog, 'trial').name, 'Qwen3.8 Flash-Next (Strata trial) (160K)');
  // The route is named by the router and limited by the models it serves: one
  // slot per distinct model, so the router's own per-model queue stays the limit.
  assert.equal(catalog.displayName, 'llm-router');
  assert.equal(catalog.maxConcurrency, 3);
  const selection = config(await rows(file), 'agent-default-model');
  assert.equal(selection.provider, 'local-ollama');
  assert.equal(selection.model, 'daytime');
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /fixture-|local-active|qwen3\.8-flash-next|256k/);
  // The service is withdrawn: held with its reason, announced, and the update
  // still succeeds — a missing opt-in service is never a failed update.
  router.publish(paired());
  const second = await launch(home);
  assert.match(second.stdout, /^trial: unavailable \(not offered by the router\) \[opt-in service; never selected automatically\]$/m);
  const held = config(await rows(file), 'llm-pi-ai').providers['local-ollama'];
  assert.equal(row(held, 'trial').id, 'trial');
  assert.equal(held.residentStates.trial.status, 'unavailable');
  // A row that no model answers names itself and its state: the title the router
  // published describes a model that is not on offer.
  assert.equal(held.residentStates.trial.label, 'trial — unavailable');
  assert.equal(held.residentStates.trial.limits, 'stale');
  assert.equal(config(await rows(file), 'agent-default-model').provider, 'local-ollama');
  assert.equal(config(await rows(file), 'agent-default-model').model, 'daytime');
  assert.equal(held.residentStates.daytime.status, 'available');
  assert.equal(held.residentStates.nighttime.status, 'available');
});

// Contract 1.2 §3: a published configuration can declare no `daytime` at all, and
// does not list it in `offline_services` either. Its row is held with that
// reason; the update still exits 0, the row keeps its own stored limits, and
// the only model actually serving — the opt-in trial — is never taken up.
test('a configuration with no daytime at all holds its row, exits 0, and never reaches for the trial', { skip: !YAML }, async t => {
  const router = await fakeRouter(t, strata());
  const { home, file } = await fixture(t, router.baseURL);
  const before = config(await rows(file), 'llm-pi-ai').providers['local-ollama'];
  const result = await launch(home);
  assert.match(result.stdout, /^daytime: unavailable \(not offered by the router\)$/m);
  assert.match(line(result.stdout, 'trial'), /^trial: available$/);
  const catalog = config(await rows(file), 'llm-pi-ai').providers['local-ollama'];
  assert.equal(catalog.residentStates.daytime.status, 'unavailable');
  assert.equal(catalog.residentStates.daytime.reason, 'not offered by the router');
  assert.equal(catalog.residentStates.daytime.service, 'daytime');
  assert.equal(row(catalog, 'daytime').id, 'daytime');
  assert.equal(row(catalog, 'daytime').name, 'daytime — unavailable', 'the held row still names the service it waits for');
  assert.equal(row(catalog, 'daytime').contextWindow, row(before, 'daytime').contextWindow);
  // No other model's numbers fill the gap: the trial's 160K context and text-only
  // modalities stay on the trial's own row.
  assert.equal(row(catalog, 'trial').contextWindow, 163840 - 1024);
  assert.deepEqual(row(catalog, 'trial').input, ['text']);
  // The trial is the only service this configuration offers, and it is still not
  // a default: the saved selection stays on the held daytime row.
  const selection = config(await rows(file), 'agent-default-model');
  assert.equal(selection.provider, 'local-ollama');
  assert.equal(selection.model, 'daytime');
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /fixture-|local-active|qwen3\.8|256k/);
});

// A host runtime installed by an earlier image carries an older availability
// patch; the packaged CI runtime (DSH_TEST_HARNESS=1) always carries this one.
let adapterSource;
try { adapterSource = YAML && await fs.readFile(path.join(runtime, 'node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'), 'utf8'); } catch {}
const staleRuntime = Boolean(adapterSource) && !adapterSource.includes('dsh-resident-availability-v4');
if (staleRuntime && process.env.DSH_TEST_HARNESS === '1') throw new Error('the packaged runtime lacks the current availability patch');

test('real pinned adapter: per-model state, state messages, switching dispatch and legacy IDs', { skip: !YAML ? true : staleRuntime ? 'installed runtime predates this availability patch; set DSH_RUNTIME_ROOT' : false }, async t => {
  const { patchAdapter } = await import('../scripts/patch-dsh-resident-availability.mjs');
  const { pathToFileURL } = await import('node:url');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'resident-adapter-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.symlink(path.join(runtime, 'node_modules'), path.join(temporary, 'node_modules'));
  const source = adapterSource;
  await fs.writeFile(path.join(temporary, 'adapter.mjs'), patchAdapter(source) + '\nexport { resolveProfiles };');
  const { Config, resolveProfiles, PiAiAdapter } = await import(pathToFileURL(path.join(temporary, 'adapter.mjs')));
  const offline = { service: 'nighttime', status: 'offline', label: 'Nighttime — offline (flash-next-solo-128k)',
    message: 'Nighttime is offline in router configuration "flash-next-solo-128k". Select another model, or retry when it returns.', configuration: 'flash-next-solo-128k', limits: 'stale' };
  const switching = { service: 'daytime', status: 'switching', label: 'Daytime — router switching configuration', limits: 'stale' };
  const config = Config({ providers: {
    // One route, one catalog: each model row answers to its own recorded state,
    // so a blocked service fails at once while its router keeps answering.
    'local-ollama': { api: 'openai-responses', baseURL: 'http://127.0.0.1:1/v1', residentUnavailable: false,
      residentState: { status: 'switching', default: 'daytime' }, residentStates: { daytime: switching, nighttime: offline },
      models: [{ id: 'daytime', name: 'Qwen3.8 27B Q6_K (160K)', contextWindow: 162816, input: ['text', 'image'] },
        { id: 'nighttime', name: 'Nighttime', contextWindow: 97280, input: ['text'] }] },
    // A router that answers nothing blocks every model of its route.
    'local-backup': { api: 'openai-responses', baseURL: 'http://127.0.0.1:2/v1', residentUnavailable: true,
      residentState: { status: 'unavailable', reason: 'router unreachable', message: 'The router is unreachable.' },
      models: [{ id: 'daytime', name: 'Qwen3.8 27B Q6_K (160K)' }] },
    'amazon-bedrock': { models: [{ id: 'amazon.nova-lite-v1:0' }] },
  } });
  const profiles = resolveProfiles(config.providers.get());
  // alpha.5 resolves the provider API key inside listModels (returning an
  // empty catalog on a missing credential). These fixtures declare no
  // apiKeyEnv, so the real resolver yields undefined; mirror that.
  const adapter = new PiAiAdapter({ profiles: () => profiles, auth: {}, resolveApiKey: async () => undefined });
  const models = await adapter.listModels('local-ollama');
  const [day, night] = models;
  assert.equal(day.available, true, 'a switching router does not block selection or dispatch');
  assert.equal(day.name, 'Daytime — router switching configuration');
  assert.equal(night.available, false, 'a service no model answers is not selectable');
  assert.equal(night.name, offline.label);
  assert.ok('inputModalities' in day, 'an unblocked model states what it accepts');
  assert.equal('inputModalities' in night, false);
  assert.throws(() => adapter.prepareCall('local-ollama', 'nighttime'), error => error.code === 'MODEL_UNAVAILABLE' && /offline in router configuration "flash-next-solo-128k"/.test(error.message));
  // The blocked service does not block the route: another model of the same
  // catalog still dispatches.
  assert.equal((await adapter.prepareCall('local-ollama', 'daytime')).model.id, 'daytime');
  assert.throws(() => adapter.prepareCall('local-backup', 'daytime'), error => error.code === 'MODEL_UNAVAILABLE' && /router is unreachable/.test(error.message));
  // A selection written before a catalog drove the model list names a model this
  // route no longer configures; the document's own default service serves it.
  const prepared = await adapter.prepareCall('local-ollama', 'local-active');
  assert.equal(prepared.model.id, 'local-active');
  assert.equal(prepared.model.context.contextWindow, 162816);
  assert.equal((await adapter.listModels('amazon-bedrock'))[0].id, 'amazon.nova-lite-v1:0');
});
