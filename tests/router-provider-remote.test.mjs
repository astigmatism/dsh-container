import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouterContract, verifyConfiguredRoutes } from '../scripts/verify-router-contract.mjs';
const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const contract = await loadRouterContract();
const { routerMetadataOf, resolveRouterEntry, synchronizeRouterSettings, applyOperation } = contract;
const PRIMARY = 'qwen3.8-27b-q8_0';
const SECONDARY = 'qwen3.8-27b-abliterated-q6_k';

function entry(id, { unrestricted = true, primary = id === PRIMARY } = {}) {
  const max = unrestricted ? null : 8192;
  const defaultTokens = unrestricted ? null : 1024;
  return { id, object: 'model', x_ollama_router: {
    schema_version: 2, complete: true, warnings: [], alias: false, upstream_model: id,
    aliases: primary ? ['local-active'] : [], display_name: primary ? 'Primary' : 'Secondary',
    health: { available: true, status: 200 }, context_window: 131072,
    active_request_limit: 1, output_policy: unrestricted ? 'unrestricted' : 'bounded',
    max_output_tokens: max, default_output_tokens: defaultTokens,
    input_modalities: primary ? ['text', 'image'] : ['text'],
    capabilities: primary ? ['completion', 'thinking', 'tools', 'vision'] : ['completion', 'thinking'],
    reasoning: {
      supported: true, default: unrestricted ? 'default' : 'medium',
      efforts: { default: 'default', off: 'none', low: 'low', medium: 'medium', xhigh: 'xhigh' },
      aliases: { none: 'off', minimal: 'low', high: 'xhigh', max: 'xhigh' },
      output_limit_policy: 'reject', absolute_max_output_tokens: max,
      per_effort: Object.fromEntries(['default', 'off', 'low', 'medium', 'xhigh'].map(level => [level,
        { enabled: level !== 'off', default_output_tokens: defaultTokens, max_output_tokens: max }]))
    }
  }};
}
function alias(row) {
  return { ...structuredClone(row), id: 'local-active', x_ollama_router: { ...structuredClone(row.x_ollama_router), alias: true } };
}
function legacySettings(baseURL) {
  return {
    'agent-default-model': { provider: 'local-ollama-256k', model: 'local-active', reasoningEffort: 'off', custom: 'retain' },
    'custom-setting': { preserved: true },
    'llm-pi-ai': { providers: {
      'local-ollama': { api: 'openai-responses', apiKeyEnv: 'UNCHANGED_CREDENTIAL_REFERENCE', baseURL, reasoning: 'medium', maxConcurrency: 2,
        models: [{ id: 'local-active', name: 'Legacy', contextWindow: 262144, maxTokens: 32768, input: ['text', 'image'], custom: 'retain' }] },
      'local-ollama-256k': { baseURL, models: [{ id: 'local-active' }] },
      custom: { baseURL: 'https://unrelated.invalid', reasoning: 'low', models: [{ id: 'custom' }] }
    }}
  };
}
function service(state, mutations = []) {
  return {
    get: namespace => state[namespace],
    describe: () => [{ ns: 'llm-pi-ai', user: state['llm-pi-ai'] }],
    mutate: async (namespace, ops) => {
      mutations.push({ namespace, ops });
      for (const op of ops) applyOperation(state[namespace], op);
    }
  };
}
async function fixture(t, data) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dsh-router-remote-'));
  const state = { data };
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(state)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true }); });
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
  return { state, baseURL, settingsFile, async remote(settings) {
    await writeFile(settingsFile, JSON.stringify(settings));
    return run('sh', [wrapper], { env: { ...process.env, TEST_NODE: process.execPath, TEST_ROOT: root, TEST_SETTINGS: settingsFile } });
  }};
}

test('normal startup migration and the exact remote-direct verifier accept canonical-only aliases, then explicit alias rows', async t => {
  const primary = entry(PRIMARY), secondary = entry(SECONDARY);
  const f = await fixture(t, [primary, secondary]);
  const state = legacySettings(f.baseURL);
  const unrelated = structuredClone(state['llm-pi-ai'].providers.custom);
  const mutations = [];
  await synchronizeRouterSettings(service(state, mutations));
  const providers = state['llm-pi-ai'].providers;
  assert.equal(providers['local-ollama'].models[0].maxTokens, null);
  assert.equal(providers['local-ollama'].reasoning, 'medium');
  assert.deepEqual(providers['local-everyday'].models[0].input, ['text']);
  assert.equal(providers['local-everyday'].models[0].contextWindow, 131072);
  assert.equal(providers['local-everyday'].reasoning, 'medium');
  assert.equal(providers['local-ollama'].models[0].custom, 'retain');
  assert.equal(providers['local-ollama'].apiKeyEnv, 'UNCHANGED_CREDENTIAL_REFERENCE');
  assert.deepEqual(providers.custom, unrelated);
  assert.deepEqual(state['custom-setting'], { preserved: true });
  assert.deepEqual(state['agent-default-model'], { provider: 'local-ollama', model: 'local-active', reasoningEffort: 'off', custom: 'retain' });
  assert.equal(providers['local-ollama-256k'], undefined);
  assert.match((await f.remote(state)).stdout, /Verified/);
  f.state.data.push(alias(primary));
  assert.match((await f.remote(state)).stdout, /Verified/);
  const count = mutations.length;
  await synchronizeRouterSettings(service(state, mutations));
  assert.equal(mutations.length, count, 'startup migration is idempotent');
  await verifyConfiguredRoutes(state, { browser: true });
  state['agent-default-model'] = { provider: 'local-everyday', model: SECONDARY };
  await assert.rejects(verifyConfiguredRoutes(state, { browser: true }), /missing vision capability/);
  providers['local-ollama'].maxConcurrency = 2;
  await assert.rejects(f.remote(state), error => error.code === 22 && /concurrency is not synchronized/.test(error.stderr));
});

test('legacy bounded alias and actual IDs remain valid while explicit effort choices survive migration', async t => {
  const primary = entry(PRIMARY, { unrestricted: false });
  const f = await fixture(t, [alias(primary)]);
  const state = legacySettings(f.baseURL);
  state['llm-pi-ai'].providers['local-ollama'].reasoning = 'low';
  await synchronizeRouterSettings(service(state));
  assert.equal(state['llm-pi-ai'].providers['local-ollama'].reasoning, 'low');
  assert.equal(state['llm-pi-ai'].providers['local-ollama'].models[0].maxTokens, 8192);
  assert.equal(state['llm-pi-ai'].providers['local-everyday'], undefined);
  assert.match((await f.remote(state)).stdout, /Verified/);
  f.state.data = [primary];
  state['llm-pi-ai'].providers['local-ollama'].models[0].id = PRIMARY;
  assert.match((await f.remote(state)).stdout, /Verified/);
});

test('malformed or unavailable metadata fails closed before startup mutation and remote verification', async t => {
  const f = await fixture(t, [entry(PRIMARY), entry(SECONDARY)]);
  const state = legacySettings(f.baseURL);
  for (const mutate of [
    meta => { meta.warnings = ['BACKEND_STATUS_UNAVAILABLE']; },
    meta => { meta.health.available = false; },
    meta => { delete meta.default_output_tokens; },
    meta => { meta.reasoning.absolute_max_output_tokens = 32768; },
    meta => { meta.reasoning.per_effort.medium.max_output_tokens = 32768; },
    meta => { meta.output_policy = 'unknown'; },
    meta => { meta.capabilities = ['completion', 'thinking']; },
    meta => { meta.reasoning.default = 'unsupported'; }
  ]) {
    f.state.data = [entry(PRIMARY), entry(SECONDARY)];
    mutate(f.state.data[0].x_ollama_router);
    const before = structuredClone(state);
    await assert.rejects(synchronizeRouterSettings(service(state)));
    assert.deepEqual(state, before);
    await assert.rejects(f.remote(state), error => error.code === 22);
  }
});

test('resolver rejects ambiguous aliases and inconsistent alias rows, and validates both output policies', () => {
  const primary = entry(PRIMARY);
  assert.equal(resolveRouterEntry({ data: [primary] }, 'local-active'), primary);
  assert.throws(() => resolveRouterEntry({ data: [primary, structuredClone(primary)] }, 'local-active'), /ambiguous/);
  const mismatched = alias(primary);
  mismatched.x_ollama_router.active_request_limit = 2;
  assert.throws(() => resolveRouterEntry({ data: [primary, mismatched] }, 'local-active'), /disagrees/);
  const bounded = entry(PRIMARY, { unrestricted: false });
  assert.equal(routerMetadataOf(bounded).max_output_tokens, 8192);
  bounded.x_ollama_router.reasoning.per_effort.medium.default_output_tokens = 9000;
  assert.throws(() => routerMetadataOf(bounded), /invalid limits/);
});


test('provisioning rejects an inherited effort absent from the target before any mutation', async t => {
  const secondary = entry(SECONDARY);
  delete secondary.x_ollama_router.reasoning.efforts.medium;
  delete secondary.x_ollama_router.reasoning.per_effort.medium;
  const f = await fixture(t, [entry(PRIMARY), secondary]);
  const state = legacySettings(f.baseURL);
  const before = structuredClone(state);
  const mutations = [];
  await assert.rejects(synchronizeRouterSettings(service(state, mutations)), /configured reasoning effort: medium/);
  assert.equal(mutations.length, 0);
  assert.deepEqual(state, before);
});


test('remote-direct readiness retains the primary vision/tools requirement without imposing it on the secondary', async t => {
  const primary = entry(PRIMARY);
  primary.x_ollama_router.input_modalities = ['text'];
  primary.x_ollama_router.capabilities = ['completion', 'thinking'];
  const f = await fixture(t, [primary, entry(SECONDARY)]);
  const state = legacySettings(f.baseURL);
  await synchronizeRouterSettings(service(state));
  await verifyConfiguredRoutes(state);
  await assert.rejects(f.remote(state), error => error.code === 22 && /missing vision capability/.test(error.stderr));
});
