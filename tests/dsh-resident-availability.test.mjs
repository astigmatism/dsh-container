import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { patchAdapter, patchRegistry, patchCatalog, patchClient, patchCatalogCodec, patchRetry } from '../scripts/patch-dsh-resident-availability.mjs';
import { EndpointConcurrencyGate } from '../scripts/patch-dsh-llm-pi-ai.mjs';
const fixture = JSON.parse(await readFile(new URL('./fixtures/dsh-resident-availability-0.2.0-rc.2.json', import.meta.url)));
const clone = value => JSON.parse(JSON.stringify(value));
class LlmError extends Error { constructor(message, code) { super(message); this.code = code; } }
function adapter() {
  const source = patchAdapter(fixture.adapter);
  const Adapter = vm.runInNewContext(source.slice(source.indexOf('var PiAiAdapter')) + '\nPiAiAdapter', {
    LlmAdapter: class {}, LlmError, EndpointConcurrencyGate, AbortController, AbortSignal,
    resolveReasoningLevel: () => 'medium', contentHasImage: () => false,
    toPiContext: () => ({}), timeoutOf: () => undefined,
    idleWatchdog: signal => ({ signal, next: iterator => iterator.next() }),
    __addDisposableResource: (_env, value) => value,
    __disposeResources: env => { if (env.hasError) throw env.error; },
    toStreamChunks: value => value, profileOptions: () => ({}), requestHeaders: () => ({}),
    describableReasoningLevel: () => undefined, reasoningInfo: () => ({}),
  });
  const profile = { provider: 'local-everyday', baseURL: 'http://fixture', maxConcurrency: 1,
    modelErrors: new Map(), configuredMaxTokens: new Map() };
  const model = { id: 'night', name: 'Nighttime', input: ['text'], contextWindow: 128000 };
  let calls = 0;
  const snapshot = { profiles: new Map([['local-everyday', profile]]), models: {
    getModel: (_provider, id) => id === 'night' ? model : undefined, getModels: () => [model],
    streamSimple: async function* () { calls++; yield { type: 'text', text: 'night-only' }; },
  } };
  const value = new Adapter({ resolveApiKey: async () => 'synthetic' });
  value.current = () => snapshot;
  return { value, profile, snapshot, calls: () => calls };
}
const request = { provider: 'local-everyday', model: 'night', messages: [] };

test('pinned availability patches are idempotent and fail on source drift', () => {
  for (const [key, patch] of [['adapter', patchAdapter], ['registry', patchRegistry], ['catalog', patchCatalog], ['client', patchClient], ['retry', patchRetry], ['codec', patchCatalogCodec], ['clientCodec', patchCatalogCodec]]) {
    const result = patch(fixture[key]);
    assert.equal(patch(result), result);
    assert.throws(() => patch('unknown new runtime'), /source drift/);
  }
});

test('unavailable models remain inspectable but cannot prepare or dispatch; exact model resumes on return', async () => {
  const f = adapter();
  f.profile.residentUnavailable = true;
  const models = await f.value.listModels('local-everyday');
  assert.equal(models[0].available, false);
  assert.equal(models[0].name, 'Nighttime — unavailable');
  assert.deepEqual(clone(await f.value.resolveModel('local-everyday', 'night')), {
    provider: 'local-everyday', id: 'night', name: 'Nighttime — unavailable',
  });
  assert.throws(() => f.value.prepareCall('local-everyday', 'night'), e => e.code === 'MODEL_UNAVAILABLE');
  await assert.rejects(f.value.stream(request).next(), e => e.code === 'MODEL_UNAVAILABLE');
  assert.equal(f.calls(), 0);
  f.profile.residentUnavailable = false;
  assert.equal((await f.value.stream(request).next()).value.text, 'night-only');
  assert.equal(f.calls(), 1);
});

test('a request waiting for capacity rechecks availability without cancelling an active stream', async () => {
  const f = adapter();
  const active = f.value.stream(request);
  assert.equal((await active.next()).value.text, 'night-only');
  const queued = f.value.stream(request).next();
  // Let credential resolution and the queue admission settle.
  await new Promise(resolve => setImmediate(resolve));
  f.profile.residentUnavailable = true;
  assert.equal((await active.next()).done, true, "the active stream completes normally");
  await assert.rejects(queued, e => e.code === 'MODEL_UNAVAILABLE');
  assert.equal(f.calls(), 1);
});

test('registry and catalog preserve unavailable identity, external groups, and an unavailable default', async () => {
  const f = adapter(); f.profile.residentUnavailable = true;
  const Registry = vm.runInNewContext('class Registry {' + patchRegistry(fixture.registry) + '}\nRegistry', { LlmError });
  const registry = new Registry();
  registry.registration = () => ({ adapter: f.value }); registry.detachedModalities = value => value;
  const listed = await registry.listModels('local-everyday');
  assert.equal(listed[0].available, false);
  const catalog = vm.runInNewContext(patchCatalog(fixture.catalog) + '\n({ buildModelCatalog, modelAvailable })', { RemoteError: Error });
  const selected = { provider: 'local-everyday', model: 'night', reasoningEffort: 'high' };
  const ctx = { agentDefaultModel: { currentSelection: () => selected }, llm: {
    listProviders: () => [{ id: 'local-everyday' }, { id: 'amazon-bedrock' }],
    listModels: async id => id === 'local-everyday' ? listed : [{ id: 'claude', name: 'Claude' }],
    resolveModelInfo: async id => { assert.equal(id, 'amazon-bedrock'); return {}; },
  } };
  const result = await catalog.buildModelCatalog(ctx);
  assert.deepEqual(clone(result.default), selected);
  assert.deepEqual(clone(result.routableProviders), ['amazon-bedrock']);
  assert.equal(result.groups.length, 2);
  assert.equal(await catalog.modelAvailable(ctx, selected), false);
});

test('client renders unavailable choices disabled and prevents alternate-picker selection', () => {
  const source = patchClient(fixture.client);
  assert.match(source, /disabled: busy \|\| model.available === false/);
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
    assert.match(patched, /['"]available['"]: (?:z\.)?boolean\(\)\.optional\(\)/);
    // The added field belongs to each model, inside its models array.
    assert.ok(patched.indexOf('available') > patched.indexOf('models'));
  }
});


test('keyboard selection also blocks unavailable models without submitting an RPC', () => {
  const source = patchClient(fixture.client);
  const start = source.indexOf('const choose = (selection) => {');
  const end = source.indexOf('const chooseEffort', start);
  const submissions = [];
  const choices = [{ selection: { provider: 'local-everyday', model: 'night' }, model: { available: false } },
    { selection: { provider: 'amazon-bedrock', model: 'nova' }, model: {} }];
  const choose = vm.runInNewContext(source.slice(start, end) + '\nchoose', {
    choices, state: { current: null }, closeAfterSelection() {}, submit: value => submissions.push(value),
  });
  choose(choices[0].selection);
  assert.equal(submissions.length, 0);
  choose(choices[1].selection);
  assert.equal(submissions[0].provider, 'amazon-bedrock');
  choices[0].model.available = true;
  choose(choices[0].selection);
  assert.equal(submissions[1].provider, 'local-everyday');
});


test('unavailable failures never replay, including a saved always-retry policy', async () => {
  const recover = vm.runInNewContext(patchRetry(fixture.retry) + '\nrecover');
  for (const policy of [{ mode: 'always' }, { mode: 'normal', retryableCodes: ['MODEL_UNAVAILABLE'] }]) {
    let downstream = 0;
    assert.equal(await recover({ failure: { code: 'MODEL_UNAVAILABLE' }, retryPolicy: policy }, () => downstream++), undefined);
    assert.equal(downstream, 0);
  }
  let downstream = 0;
  await recover({ failure: { code: 'UNRELATED_ERROR' } }, () => downstream++);
  assert.equal(downstream, 1, 'other failures retain their normal recovery path');
});

test('discovery state drives the one picker label and the dispatch message; a switching router never blocks', async () => {
  const f = adapter();
  f.profile.residentUnavailable = true;
  f.profile.residentState = { service: 'night', status: 'offline', label: 'Nighttime — offline (flash-next-solo-128k)',
    message: 'Nighttime is offline in router configuration "flash-next-solo-128k". Switch this session to Daytime.' };
  assert.equal((await f.value.listModels('local-everyday'))[0].name, 'Nighttime — offline (flash-next-solo-128k)');
  assert.throws(() => f.value.prepareCall('local-everyday', 'night'), e => e.code === 'MODEL_UNAVAILABLE' && /Switch this session to Daytime/.test(e.message));
  await assert.rejects(f.value.stream(request).next(), e => e.code === 'MODEL_UNAVAILABLE');
  f.profile.residentUnavailable = false;
  f.profile.residentState = { service: 'night', status: 'switching', label: 'Nighttime — router switching configuration' };
  const listed = (await f.value.listModels('local-everyday'))[0];
  assert.equal(listed.available, true);
  assert.equal(listed.name, 'Nighttime — router switching configuration');
  assert.equal((await f.value.stream(request).next()).value.text, 'night-only', 'requests are sent and wait on the router');
  f.profile.residentState = { service: 'night', status: 'available', label: 'Nighttime (96K) · NSFW' };
  assert.equal((await f.value.listModels('local-everyday'))[0].name, 'Nighttime', 'an available model shows its configured name');
});

test('old persisted model IDs of a resident route resolve to its service model', async () => {
  const f = adapter();
  f.profile.residentState = { service: 'night', status: 'available', label: 'Nighttime' };
  const resolved = await f.value.resolveModel('local-everyday', 'qwen3.8-27b-abliterated-q6_k');
  assert.equal(resolved.id, 'qwen3.8-27b-abliterated-q6_k', 'the requested identity is echoed for dsh-llm validation');
  assert.equal(resolved.name, 'Nighttime');
  assert.equal((await f.value.stream({ ...request, model: 'qwen3.8-27b-abliterated-q6_k' }).next()).value.text, 'night-only');
  delete f.profile.residentState;
  assert.throws(() => f.value.modelOf(f.snapshot, 'local-everyday', 'unrelated'), /no configured model|getModel|undefined/i);
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
