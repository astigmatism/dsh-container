import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { patchAdapter, patchRegistry, patchCatalog, patchClient, patchCatalogCodec, patchRetry, modelPickerAvailableOnly } from '../scripts/patch-dsh-resident-availability.mjs';
import { EndpointConcurrencyGate } from '../scripts/patch-dsh-llm-pi-ai.mjs';
const fixture = JSON.parse(await readFile(new URL('./fixtures/dsh-resident-availability-0.2.1-alpha.5.json', import.meta.url)));
const clone = value => JSON.parse(JSON.stringify(value));
// One router is one route: it carries every service the router's capabilities
// document publishes, and each model row answers to its own recorded state.
const route = (overrides = {}) => ({ status: 'available', reason: null, configuration: 'solo-128k',
  services: [{ service: 'day', status: 'available' }, { service: 'night', status: 'available' }], default: 'day', ...overrides });
const recorded = (service, name, overrides = {}) => ({ service, status: 'available', label: name,
  configuration: 'solo-128k', reason: null, limits: 'current', nsfw: null, ...overrides });
const offlineState = (service, configuration = 'flash-next-solo-128k') => recorded(service, `${service} — offline (${configuration})`, {
  status: 'offline', limits: 'stale', configuration,
  message: `${service} is offline in router configuration "${configuration}". Select another model, or retry when ${service} returns; Harness reconnects automatically.` });
const unavailableState = service => recorded(service, `${service} — not offered`, {
  status: 'unavailable', reason: 'not offered by the router', limits: 'stale', configuration: 'solo-128k',
  message: `${service} is unavailable: the router does not offer it. Select another model, or retry when ${service} returns; Harness reconnects automatically.` });
const switchingState = (service, name) => recorded(service, `${name} — router switching configuration`, {
  status: 'switching', reason: 'draining', limits: 'stale',
  message: `The router is switching configuration (draining); requests to ${name} wait and retry without changing models.` });
// Dependency-free stand-in for the installed `yaml` package, faithful to it on
// the settings shapes this patch reads (verified against it in the container).
function parseSettingsLite(text) {
  const lines = text.split('\n').filter(line => line.trim() !== '' && !line.trim().startsWith('#'));
  if (lines.length === 0) return null;
  const scalar = value => value === 'true' ? true : value === 'false' ? false : value;
  if (lines[0].startsWith('- ')) {
    const entries = [];
    for (const line of lines) {
      const item = line.match(/^- id: (\S+)$/);
      if (item) { entries.push({ id: item[1], config: {} }); continue; }
      const config = line.match(/^    (\w+): (\S+)$/);
      if (config && entries.length > 0) entries.at(-1).config[config[1]] = scalar(config[2]);
    }
    return entries;
  }
  const out = {};
  let section = null;
  for (const line of lines) {
    const top = line.match(/^(\w+):$/);
    if (top) { out[top[1]] = {}; section = out[top[1]]; continue; }
    const nested = line.match(/^  (\w+): (\S+)$/);
    if (nested && section) section[nested[1]] = scalar(nested[2]);
  }
  return out;
}
const settingsFiles = files => async file => {
  if (!(file in files)) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; }
  return files[file];
};
class LlmError extends Error { constructor(message, code) { super(message); this.code = code; } }
function adapter() {
  const source = patchAdapter(fixture.adapter);
  const Adapter = vm.runInNewContext(source.slice(source.indexOf('var PiAiAdapter')) + '\nPiAiAdapter', {
    LlmAdapter: class {}, LlmError, EndpointConcurrencyGate, AbortController, AbortSignal,
    resolveReasoningLevel: () => 'medium', contentHasImage: () => false, conversationUpdates: () => ({}),
    toPiContext: () => ({}), timeoutOf: () => undefined,
    idleWatchdog: signal => ({ signal, next: iterator => iterator.next() }),
    __addDisposableResource: (_env, value) => value,
    __disposeResources: env => { if (env.hasError) throw env.error; },
    toStreamChunks: value => value, profileOptions: () => ({}), requestHeaders: () => ({}),
    describableReasoningLevel: () => undefined, reasoningInfo: () => ({}),
  });
  const profile = { provider: 'local-everyday', baseURL: 'http://fixture', maxConcurrency: 1,
    modelErrors: new Map(), configuredMaxTokens: new Map(), residentState: route(),
    residentStates: { day: recorded('day', 'Daytime'), night: recorded('night', 'Nighttime') } };
  const models = new Map([
    ['day', { id: 'day', name: 'Daytime', input: ['text'], contextWindow: 200000 }],
    ['night', { id: 'night', name: 'Nighttime', input: ['text'], contextWindow: 128000 }],
  ]);
  let calls = 0;
  const snapshot = { profiles: new Map([['local-everyday', profile]]), models: {
    getModel: (_provider, id) => models.get(id), getModels: () => [...models.values()],
    streamSimple: async function* (model) { calls++; yield { type: 'text', text: `${model.id}-only` }; },
  } };
  const value = new Adapter({ resolveApiKey: async () => 'synthetic' });
  value.current = () => snapshot;
  const state = (id, overrides) => { profile.residentStates[id] = { ...profile.residentStates[id], ...overrides }; };
  return { value, profile, snapshot, state, calls: () => calls };
}
const request = { provider: 'local-everyday', model: 'night', messages: [] };
const dayRequest = { provider: 'local-everyday', model: 'day', messages: [] };
// The endpoint gate holds its slot until a stream is closed, so a test that
// sends more than one request reads one chunk and closes the stream it read.
const sends = async (f, req = request) => {
  const stream = f.value.stream(req);
  const chunk = await stream.next();
  await stream.return();
  return chunk.value?.text;
};
const row = (models, id) => models.find(model => model.id === id);

test('pinned availability patches are idempotent and fail on source drift', () => {
  for (const [key, patch] of [['adapter', patchAdapter], ['registry', patchRegistry], ['catalog', patchCatalog], ['client', patchClient], ['retry', patchRetry], ['codec', patchCatalogCodec], ['clientCodec', patchCatalogCodec]]) {
    const result = patch(fixture[key]);
    assert.equal(patch(result), result);
    assert.throws(() => patch('unknown new runtime'), /source drift/);
  }
});

test('one blocked model fails dispatch while its neighbour on the same route keeps working', async () => {
  const f = adapter();
  f.state('night', offlineState('night'));
  const models = await f.value.listModels('local-everyday');
  const night = row(models, 'night');
  assert.equal(night.available, false);
  assert.equal(night.name, 'night — offline (flash-next-solo-128k)');
  assert.ok(!('inputModalities' in night), 'a blocked model reports no modalities');
  const day = row(models, 'day');
  assert.equal(day.available, true, 'the route still answers for the model the router serves');
  assert.deepEqual(clone(day.inputModalities), ['text']);
  assert.deepEqual(clone(await f.value.resolveModel('local-everyday', 'night')), {
    provider: 'local-everyday', id: 'night', name: 'night — offline (flash-next-solo-128k)',
  });
  assert.throws(() => f.value.prepareCall('local-everyday', 'night'), e => e.code === 'MODEL_UNAVAILABLE');
  await assert.rejects(f.value.stream(request).next(), e => e.code === 'MODEL_UNAVAILABLE'
    && /offline in router configuration "flash-next-solo-128k"/.test(e.message), 'the model states its own advice');
  assert.equal(f.calls(), 0, 'a blocked model never reaches the router');
  assert.equal(await sends(f, dayRequest), 'day-only', 'the other model on the route dispatches');
  f.state('night', { status: 'available', label: 'Nighttime', limits: 'current', configuration: 'solo-128k', message: undefined });
  assert.equal(await sends(f), 'night-only', 'the exact model resumes when the router offers it again');
});

test('a request waiting for capacity rechecks availability without cancelling an active stream', async () => {
  const f = adapter();
  const active = f.value.stream(request);
  assert.equal((await active.next()).value.text, 'night-only');
  const queued = f.value.stream(request).next();
  // Let credential resolution and the queue admission settle.
  await new Promise(resolve => setImmediate(resolve));
  f.state('night', unavailableState('night'));
  assert.equal((await active.next()).done, true, "the active stream completes normally");
  await assert.rejects(queued, e => e.code === 'MODEL_UNAVAILABLE');
  assert.equal(f.calls(), 1);
});

test('a model the router dropped, and one whose metadata is incomplete, fail at once', async () => {
  for (const state of [unavailableState('night'), recorded('night', 'night — incomplete', {
    status: 'incomplete', reason: 'router capabilities document has invalid offline_services', limits: 'stale',
    message: 'night is unavailable: the router published incomplete metadata for it (invalid offline_services).',
  })]) {
    const f = adapter();
    f.state('night', state);
    assert.equal(row(await f.value.listModels('local-everyday'), 'night').available, false, state.status);
    assert.throws(() => f.value.prepareCall('local-everyday', 'night'), e => e.code === 'MODEL_UNAVAILABLE' && e.message === state.message);
    await assert.rejects(f.value.stream(request).next(), e => e.code === 'MODEL_UNAVAILABLE');
    assert.equal(f.calls(), 0);
  }
});

test('a model with no recorded state behaves like any other model', async () => {
  const f = adapter();
  delete f.profile.residentStates.day;
  assert.equal(f.value.residentModelState(f.profile, 'day'), undefined);
  const day = row(await f.value.listModels('local-everyday'), 'day');
  assert.equal(day.name, 'Daytime');
  assert.equal(day.available, true);
  assert.deepEqual(clone(day.inputModalities), ['text'], 'nothing is dropped from a row discovery never recorded');
  assert.equal(await sends(f, dayRequest), 'day-only');
  const plain = adapter();
  delete plain.profile.residentStates;
  delete plain.profile.residentState;
  const listed = await plain.value.listModels('local-everyday');
  assert.deepEqual(clone(listed.map(model => [model.name, model.available, model.inputModalities])),
    [['Daytime', true, ['text']], ['Nighttime', true, ['text']]]);
  assert.equal((await plain.value.stream(request).next()).value.text, 'night-only');
});

test('a draining router is waited out on its own model row, never blocked', async () => {
  const f = adapter();
  f.state('night', switchingState('night', 'Nighttime'));
  const listed = row(await f.value.listModels('local-everyday'), 'night');
  assert.equal(listed.available, true, 'a model whose router is switching stays selectable');
  assert.equal(listed.name, 'Nighttime — router switching configuration');
  assert.equal((await f.value.stream(request).next()).value.text, 'night-only', 'requests are sent and wait on the router');
  // The route-level facts say the same thing while the router drains.
  const draining = adapter();
  draining.profile.residentState = route({ status: 'switching', reason: 'draining',
    services: [{ service: 'day', status: 'switching' }, { service: 'night', status: 'switching' }] });
  assert.deepEqual((await draining.value.listModels('local-everyday')).map(model => model.available), [true, true]);
  assert.equal((await draining.value.stream(request).next()).value.text, 'night-only');
});

test('a router that answers nothing blocks every model of its route at once', async () => {
  const f = adapter();
  f.profile.residentUnavailable = true;
  f.profile.residentState = route({ status: 'unavailable', reason: 'router unreachable', configuration: null, default: 'night',
    services: [{ service: 'day', status: 'unavailable' }, { service: 'night', status: 'unavailable' }],
    message: 'The router at fixture is unreachable; every model it offers is unavailable.' });
  // Nothing recorded a state for these rows, so nothing has a label to show.
  f.profile.residentStates = { day: { service: 'day', status: 'available' }, night: { service: 'night', status: 'available' } };
  const listed = await f.value.listModels('local-everyday');
  assert.deepEqual(listed.map(model => model.available), [false, false], 'a router that answers nothing blocks all of its models');
  assert.deepEqual(listed.map(model => model.name), ['Daytime', 'Nighttime'], 'a row with no label of its own keeps its configured name');
  assert.ok(listed.every(model => !('inputModalities' in model)));
  assert.throws(() => f.value.prepareCall('local-everyday', 'night'),
    e => e.code === 'MODEL_UNAVAILABLE' && /router at fixture is unreachable/.test(e.message), 'the route states the advice its models share');
  f.state('night', { label: 'night — unreachable', message: 'night is unavailable: the router is unreachable. Select another model.' });
  assert.equal(row(await f.value.listModels('local-everyday'), 'night').name, 'night — unreachable');
  assert.throws(() => f.value.prepareCall('local-everyday', 'night'),
    e => e.code === 'MODEL_UNAVAILABLE' && /^night is unavailable: the router is unreachable\./.test(e.message), 'a model says so itself when it can');
});

test('registry and catalog preserve unavailable identity, external groups, and an unavailable default', async () => {
  const f = adapter(); f.state('night', offlineState('night'));
  const Registry = vm.runInNewContext('class Registry {' + patchRegistry(fixture.registry) + '}\nRegistry', { LlmError });
  const registry = new Registry();
  registry.registration = () => ({ adapter: f.value }); registry.detachedModalities = value => value;
  const listed = await registry.listModels('local-everyday');
  assert.equal(row(listed, 'night').available, false, 'the registry carries the blocked model through');
  assert.ok(!('available' in row(listed, 'day')), 'and drops nothing for the model that answers');
  const catalog = vm.runInNewContext(patchCatalog(fixture.catalog) + '\n({ buildModelCatalog, modelAvailable })', { RemoteError: Error, process: { env: {} }, parseYamlSettings: parseSettingsLite });
  const selected = { provider: 'local-everyday', model: 'day', reasoningEffort: 'high' };
  const asked = [];
  const ctx = { agentDefaultModel: { currentSelection: () => selected }, llm: {
    listProviders: () => [{ id: 'local-everyday' }, { id: 'local-quiet' }, { id: 'amazon-bedrock' }],
    listModels: async id => id === 'local-everyday' ? listed
      : id === 'local-quiet' ? [{ id: 'gone', name: 'gone — offline (solo)', available: false }]
        : [{ id: 'claude', name: 'Claude' }],
    resolveModelInfo: async (id, model) => { asked.push(`${id}/${model}`); return {}; },
  } };
  const result = await catalog.buildModelCatalog(ctx);
  assert.deepEqual(clone(result.default), selected);
  assert.deepEqual(clone(result.routableProviders), ['local-everyday', 'amazon-bedrock'],
    'a route with one available model stays routable; one with none leaves');
  assert.equal(result.groups.length, 3);
  assert.equal(row(result.groups[0].models, 'night').available, false, 'the blocked row is still listed, and not described');
  assert.deepEqual(asked, ['local-everyday/day', 'amazon-bedrock/claude'], 'a blocked model is never resolved');
  assert.equal(await catalog.modelAvailable(ctx, selected), true, 'the model the router serves is available');
  assert.equal(await catalog.modelAvailable(ctx, { provider: 'local-everyday', model: 'night' }), false, 'the blocked one is not');
  assert.equal(await catalog.modelAvailable(ctx, { provider: 'local-quiet', model: 'gone' }), false);
});

test('client renders unavailable choices disabled and prevents alternate-picker selection', () => {
  const source = patchClient(fixture.client);
  assert.match(source, /disabled: busy \|\| model\.available === false/);
  const start = source.indexOf('function selectionOf('), end = source.indexOf('\n\t\t}', start) + 5;
  const selectionOf = vm.runInNewContext(source.slice(start, end) + '\nselectionOf', { rowId: (p, m) => `${p}/${m}` });
  const state = { current: { provider: 'local-everyday', model: 'night' }, groups: [{ id: 'local-everyday', models: [{ id: 'night', available: false }] }] };
  assert.equal(selectionOf(state, 'local-everyday/night'), undefined);
  state.groups[0].models[0].available = true;
  assert.equal(selectionOf(state, 'local-everyday/night').model, 'night');
});


test('host and browser RPC codecs preserve model availability', () => {
  for (const key of ['codec', 'clientCodec']) {
    const patched = patchCatalogCodec(fixture[key]);
    assert.match(patched, /['"]available['"]: (?:zod\.z|z)?\.?boolean\(\)\.optional\(\)/);
    assert.match(patched, /['"]availableOnly['"]: (?:zod\.z|z)?\.?boolean\(\)\.optional\(\)/);
    // The added fields belong to the model descriptor, after the models array
    // and before the routable providers.
    assert.ok(patched.indexOf('models') < patched.indexOf('available') < patched.indexOf('routableProviders'));
  }
});

test('modelPicker.availableOnly reads the settings document and defaults off', async () => {
  const pickerRow = (value) => ['- id: modelPicker', '  config:', `    availableOnly: ${value}`].join('\n') + '\n';
  const off = (env, files) => modelPickerAvailableOnly(env, settingsFiles(files), parseSettingsLite);
  assert.equal(await off({}, {}), false, 'no directories, no files');
  assert.equal(await off({ DSH_HOME: '/h' }, { '/h/settings.yaml': ['- id: agent-default-model', '  config:', '    provider: local-ollama'].join('\n') }), false, 'a document without the section');
  assert.equal(await off({ DSH_HOME: '/h' }, { '/h/settings.yaml': pickerRow('true') }), true, 'list form, exact true');
  assert.equal(await off({ DSH_HOME: '/h' }, { '/h/settings.yaml': pickerRow('false') }), false, 'list form, false');
  assert.equal(await off({ DSH_HOME: '/h' }, { '/h/settings.yaml': pickerRow('"true"') }), false, 'a quoted string is not true');
  assert.equal(await off({ DSH_HOME: '/h' }, { '/h/settings.yaml': 'modelPicker:\n  availableOnly: true\n' }), true, 'pre-0.2 map form');
  assert.equal(await off({ DSH_PROFILE_DIR: '/p', DSH_HOME: '/h' }, { '/p/cordis.patch.yml': pickerRow('false'), '/h/settings.yaml': 'modelPicker:\n  availableOnly: true\n' }), false, 'the live profile patch wins over the legacy file');
  assert.equal(await off({ DSH_PROFILE_DIR: '/p', DSH_HOME: '/h' }, { '/h/profiles/web/cordis.patch.yml': pickerRow('true') }), true, 'a missing profile patch falls through');
  assert.equal(await modelPickerAvailableOnly({ DSH_HOME: '/h' }, settingsFiles({ '/h/settings.yaml': 'x: [' }), () => { throw new Error('yaml'); }), false, 'an unparsable document leaves the filter off');
});

test('the modelCatalog result carries the availableOnly flag from the settings document', async () => {
  const source = patchCatalog(fixture.catalog);
  const settings = '- id: modelPicker\n  config:\n    availableOnly: true\n';
  const sandbox = files => ({
    RemoteError: Error,
    process: { env: { DSH_HOME: '/h' } },
    join: (first, ...rest) => [first, ...rest].join('/'),
    readFile: settingsFiles(files),
    parseYamlSettings: parseSettingsLite,
  });
  const selected = { provider: 'local-everyday', model: 'night', reasoningEffort: 'high' };
  const ctx = { agentDefaultModel: { currentSelection: () => selected }, llm: {
    listProviders: () => [{ id: 'local-everyday' }],
    listModels: async () => [{ id: 'night', name: 'Nighttime' }],
    resolveModelInfo: async () => ({}),
  } };
  const on = vm.runInNewContext(source + '\nbuildModelCatalog', sandbox({ '/h/profiles/web/cordis.patch.yml': settings }));
  const result = await on(ctx);
  assert.equal(result.availableOnly, true, 'a modelPicker.availableOnly: true document is transported on the result');
  assert.deepEqual(clone(result.groups[0].models[0]), { id: 'night', name: 'Nighttime' }, 'the catalog still reports every model');
  const off = vm.runInNewContext(source + '\nbuildModelCatalog', sandbox({}));
  assert.equal((await off(ctx)).availableOnly, false, 'without the setting the flag stays off');
});

test('the availableOnly picker filter hides unavailable and switching rows and shows one status line', () => {
  const source = patchClient(fixture.client);
  // The flag rides the catalog result into both store writes.
  assert.match(source, /availableOnly: catalog\.value\?\.availableOnly === true/);
  assert.match(source, /availableOnly: catalog\.value\.availableOnly === true/);
  // Default off: the raw groups pass through untouched.
  assert.match(source, /state\.availableOnly === true \? state\.groups\.map/);
  assert.match(source, /state\.groups, state\.availableOnly, accountProviderName\]/);
  // One status line while a router switch drains.
  assert.match(source, /t\("status\.waitingRouter"\)/);
  assert.match(source, /"status\.waitingRouter": "Waiting on the router…"/);
  assert.match(source, /"status\.waitingRouter": "正在等待路由器切换…"/);
  const start = source.indexOf('const ROUTER_SWITCHING_SUFFIX'), end = source.indexOf('/** Dictionary namespace owned by this plugin. */', start);
  const helpers = vm.runInNewContext(source.slice(start, end) + '\n({ availableOnlyModel, routerSwitchingActive })');
  assert.equal(helpers.availableOnlyModel({ id: 'day', name: 'Daytime' }), true, 'an available row stays');
  assert.equal(helpers.availableOnlyModel({ id: 'trial', name: 'Trial', available: false }), false, 'a blocked row drops out');
  // A row whose own state says the router is switching carries the suffix as its
  // name, and is not offered either.
  assert.equal(helpers.availableOnlyModel({ id: 'night', name: 'Nighttime — router switching configuration' }), false);
  assert.equal(helpers.availableOnlyModel({ id: 'night', name: 'Nighttime — router switching configuration', available: true }), false);
  assert.equal(helpers.routerSwitchingActive([{ id: 'p', models: [{ id: 'n', name: 'Nighttime — router switching configuration' }] }]), true);
  assert.equal(helpers.routerSwitchingActive([{ id: 'p', models: [{ id: 'd', name: 'Daytime' }, { id: 'n', name: 'Nighttime', available: false }] }]), false);
});

test('a tree built by an earlier revision is left as it was built', () => {
  for (const [key, patch] of [['adapter', patchAdapter], ['retry', patchRetry]]) {
    for (const prior of ['dsh-resident-availability-v3', 'dsh-resident-availability-v2']) {
      const built = `${fixture[key]}\n// ${prior}\n`;
      assert.equal(patch(built), built, `${key} keeps the state ${prior} built`);
    }
  }
  // A release that already patched the codec keeps one declaration per field.
  let v2Codec = fixture.codec.replace("'models': z.array(z.object({", "'models': z.array(z.object({\n'available': z.boolean().optional(),");
  v2Codec = '// dsh-resident-availability-v1-codec\n' + v2Codec;
  const upgraded = patchCatalogCodec(v2Codec);
  assert.equal(upgraded.match(/'available': z\.boolean\(\)\.optional\(\)/g).length, 1);
  assert.equal(upgraded.match(/'availableOnly': z\.boolean\(\)\.optional\(\)/g).length, 1);
  assert.equal(patchCatalogCodec(upgraded), upgraded, 'idempotent after the upgrade');
});

test('the settings schema declares the per-model states alongside the route record', () => {
  const patched = patchAdapter(fixture.adapter);
  const declarations = patched.slice(patched.indexOf('residentUnavailable: z.boolean(),'), patched.indexOf('maxConcurrency: z.number().step(1).min(1),'));
  assert.match(declarations, /residentStates: z\.any\(\)/, 'the discovery-owned per-model states survive a settings round-trip');
  assert.match(declarations, /residentState: z\.any\(\)/);
});

test('a stale selection naming a retired model is served by the router document default', async () => {
  const f = adapter();
  const retired = 'qwen3.8-27b-abliterated-q6_k';
  const resolved = await f.value.resolveModel('local-everyday', retired);
  assert.equal(resolved.id, retired, 'the requested identity is echoed for dsh-llm validation');
  assert.equal(resolved.name, 'Daytime', 'the service answering the document default takes the request');
  assert.equal(await sends(f, { ...request, model: retired }), 'day-only');
  f.state('day', offlineState('day'));
  const sent = f.calls();
  await assert.rejects(f.value.stream({ ...request, model: retired }).next(),
    e => e.code === 'MODEL_UNAVAILABLE' && /"flash-next-solo-128k"/.test(e.message), 'the default answers on its own state');
  assert.equal(f.calls(), sent, 'a blocked default is not tried');
});

test('a stale selection with no default to answer it keeps the ordinary failure', async () => {
  const f = adapter();
  f.profile.residentState = { ...route(), default: 'retired-service' };
  assert.throws(() => f.value.modelOf(f.snapshot, 'local-everyday', 'unrelated'), /no configured model/);
  delete f.profile.residentState.default;
  assert.throws(() => f.value.prepareCall('local-everyday', 'unrelated'), e => e.code === 'UNKNOWN_MODEL');
  assert.throws(() => f.value.modelOf(f.snapshot, 'local-everyday', 'unrelated'), /no configured model/);
});

test('keyboard selection also blocks unavailable models without submitting an RPC', () => {
  const source = patchClient(fixture.client);
  const start = source.indexOf('const choose = (selection) => {');
  const end = source.indexOf('const chooseEffort', start);
  const submissions = [];
  const choices = [{ selection: { provider: 'local-everyday', model: 'night' }, model: { available: false } },
    { selection: { provider: 'local-everyday', model: 'day' }, model: { available: true } },
    { selection: { provider: 'amazon-bedrock', model: 'nova' }, model: {} }];
  const choose = vm.runInNewContext(source.slice(start, end) + '\nchoose', {
    choices, state: { current: null }, closeAfterSelection() {}, submit: value => submissions.push(value),
  });
  choose(choices[0].selection);
  assert.equal(submissions.length, 0, 'a blocked model does not submit');
  choose(choices[1].selection);
  assert.equal(submissions[0].provider, 'local-everyday', 'its neighbour on the same route does');
  choose(choices[2].selection);
  assert.equal(submissions[1].provider, 'amazon-bedrock');
  choices[0].model.available = true;
  choose(choices[0].selection);
  assert.equal(submissions[2].provider, 'local-everyday');
});


test('unavailable failures never replay, including a saved always-retry policy', async () => {
  const recover = vm.runInNewContext(patchRetry(fixture.retry) + '\nrecover');
  for (const policy of [{ mode: 'always' }, { mode: 'normal', retryableCodes: ['MODEL_UNAVAILABLE'] }]) {
    let downstream = 0;
    assert.equal(await recover({ failure: { code: 'MODEL_UNAVAILABLE' }, retryPolicy: policy }, () => downstream++), undefined);
    assert.equal(downstream, 0);
  }
  // §10: an invalid request is not retryable, and a saved always-retry policy
  // does not get to disagree — the router rejected the request, not a slot.
  for (const code of ['INVALID_REQUEST']) {
    let downstream = 0;
    assert.equal(await recover({ failure: { code }, retryPolicy: { mode: 'always' } }, () => downstream++), undefined,
      `${code} was recovered under an always-retry policy`);
    assert.equal(downstream, 0, `${code} was replayed`);
  }
  let downstream = 0;
  await recover({ failure: { code: 'UNRELATED_ERROR' } }, () => downstream++);
  assert.equal(downstream, 1, 'other failures retain their normal recovery path');
});

test('a draining router is waited out 2 → 30 s on its own chain without consuming the retry budget', async () => {
  const scheduled = [];
  const state = {};
  const context = {
    ctx: { sessionProjections: { stateOf: () => state } },
    retryStateKey: (provider, key) => JSON.stringify([provider, key]),
    RetryId: id => id, randomUUID: () => 'retry-chain',
    backoff: async (...args) => { scheduled.push(args); return { kind: 'retry' }; },
  };
  const recover = vm.runInNewContext(patchRetry(fixture.retry) + '\nrecover', context);
  const normal = { mode: 'normal', maxRetries: 2, retryableCodes: ['SERVER'] };
  for (let attempt = 1; attempt <= 7; attempt += 1) {
    let downstream = 0;
    const decision = await recover({ agent: { session: {} }, turn: 1, step: 1, provider: 'local-everyday',
      failure: { code: 'ROUTER_SWITCHING', message: 'draining' }, retryPolicy: normal, signal: new AbortController().signal }, () => downstream++);
    assert.deepEqual(clone(decision), { kind: 'retry' });
    assert.equal(downstream, 0);
    const [, , , failure, provider, policy, key, retry, retryId, delayMs] = scheduled.at(-1);
    assert.equal(failure.code, 'ROUTER_SWITCHING');
    assert.equal(provider, 'local-everyday');
    assert.equal(policy.mode, 'always', 'switching waits are not bounded by maxRetries');
    assert.match(key, /router-switching/);
    assert.equal(retry, attempt);
    assert.equal(retryId, 'retry-chain');
    assert.equal(delayMs, Math.min(2000 * 2 ** (attempt - 1), 30000));
    state[context.retryStateKey(provider, key)] = { retry, retryId };
  }
  // Ten minutes of waiting at the 30 s cap is well within the chain.
  const totalFirstHour = Array.from({ length: 40 }, (_, index) => Math.min(2000 * 2 ** index, 30000)).reduce((a, b) => a + b, 0);
  assert.ok(totalFirstHour > 600000);
});
