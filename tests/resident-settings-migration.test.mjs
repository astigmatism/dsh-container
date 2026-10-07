import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fakeRouter, paired, solo } from './fixtures/router-contract.mjs';

const runtime = process.env.DSH_RUNTIME_ROOT ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh';
let YAML;
try { YAML = createRequire(`${runtime}/package.json`)('yaml'); } catch (error) {
  if (process.env.DSH_TEST_HARNESS === '1') throw error;
}
const exec = promisify(execFile);
const script = new URL('../scripts/migrate-resident-models.mjs', import.meta.url).pathname;
const legacy = { 'local-ollama': 'local-active', 'local-everyday': 'qwen3.8-27b-abliterated-q6_k' };

/** A profile patch as written by releases before service IDs. */
async function fixture(t, baseURL = 'http://127.0.0.1:1/v1') {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'resident-migration-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const settings = YAML.parse(await fs.readFile(new URL('../config/settings.yaml', import.meta.url), 'utf8'));
  for (const [name, provider] of Object.entries(settings['llm-pi-ai'].providers)) {
    provider.baseURL = baseURL;
    provider.models[0].id = legacy[name];
  }
  settings['agent-default-model'].model = 'local-active';
  settings['compaction-basic'] = { modelPolicies: [
    { provider: 'local-ollama', model: 'local-active', thresholdRatio: 0.7 },
    { provider: 'local-everyday', model: 'qwen3.8-27b-abliterated-q6_k', thresholdRatio: 0.7 },
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

test('router unreachable at startup: exit 0, stored limits kept, both models unavailable, IDs migrated', { skip: !YAML }, async t => {
  const { home, file } = await fixture(t);
  const before = await rows(file);
  const result = await launch(home);
  assert.match(result.stdout, /Router discovery is unavailable at startup/);
  assert.match(result.stdout, /daytime: unavailable \(router unreachable\)/);
  const migrated = await rows(file);
  const providers = config(migrated, 'llm-pi-ai').providers;
  for (const name of ['local-ollama', 'local-everyday']) {
    assert.equal(providers[name].residentUnavailable, true);
    assert.equal(providers[name].residentState.reason, 'router unreachable');
    assert.equal(providers[name].models[0].contextWindow, config(before, 'llm-pi-ai').providers[name].models[0].contextWindow);
    assert.equal(providers[name].headers['X-Client-Name'], 'deepseek-harness/migration-fixture');
  }
  assert.deepEqual(providers['local-ollama'].models.map(row => row.id), ['daytime']);
  assert.deepEqual(providers['local-everyday'].models.map(row => row.id), ['nighttime']);
  assert.equal(config(migrated, 'agent-default-model').model, 'daytime');
  assert.deepEqual(config(migrated, 'compaction-basic').modelPolicies.map(row => row.model), ['daytime', 'nighttime', 'external']);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /local-active|qwen3\.8/, 'nothing persisted refers to a canonical model ID');
});

test('router HTTP errors are router state, not startup failures', { skip: !YAML }, async t => {
  const router = await fakeRouter(t, paired());
  router.state.respond = undefined;
  const { home, file } = await fixture(t, `${router.root}/broken/v1`);
  const result = await launch(home);
  assert.match(result.stdout, /unavailable at startup \(router capabilities returned HTTP 404/);
  assert.equal(config(await rows(file), 'llm-pi-ai').providers['local-ollama'].residentUnavailable, true);
});

test('invalid local settings are the only startup failure and leave the file unchanged', { skip: !YAML }, async t => {
  const { home, file } = await fixture(t);
  const parsed = await rows(file);
  delete config(parsed, 'llm-pi-ai').providers['local-ollama'];
  await fs.writeFile(file, YAML.stringify(parsed), { mode: 0o600 });
  const source = await fs.readFile(file, 'utf8');
  await assert.rejects(launch(home), error => error.code === 22 && /Missing local-ollama provider/.test(error.stderr));
  assert.equal(await fs.readFile(file, 'utf8'), source);
  await fs.writeFile(file, 'llm-pi-ai: [unbalanced', { mode: 0o600 });
  await assert.rejects(launch(home), error => error.code === 22 && /Invalid settings YAML/.test(error.stderr));
});

for (const selection of ['amazon-bedrock', 'local-everyday']) {
  test(`solo then paired configuration preserves ${selection}, expressions, comments and private state`, { skip: !YAML }, async t => {
    const router = await fakeRouter(t, solo());
    const { home, file } = await fixture(t, router.baseURL);
    const parsed = await rows(file);
    const providers = config(parsed, 'llm-pi-ai').providers;
    const external = { api: 'bedrock-converse-stream', apiKeyEnv: 'BEDROCK_PRIVATE_REFERENCE', headers: { Authorization: 'process.env.PRIVATE_FIXTURE' }, custom: { retain: true } };
    providers['amazon-bedrock'] = external;
    const selected = { provider: selection, model: selection === 'local-everyday' ? 'qwen3.8-27b-abliterated-q6_k' : 'external', reasoningEffort: 'high' };
    parsed.find(row => row.id === 'agent-default-model').config = selected;
    await fs.writeFile(file, YAML.stringify(parsed).replace('Authorization: process.env.PRIVATE_FIXTURE',
      'Authorization: !!js process.env.PRIVATE_FIXTURE # retain provider expression'), { mode: 0o600 });
    await fs.appendFile(file, '\n- id: unrelated-expression\n  config:\n    token: !!js process.env.PRIVATE_FIXTURE # retain expression and comment\n');
    const stat = await fs.stat(file);
    const session = `${home}/session.jsonl`;
    await fs.writeFile(session, 'unchanged session history');
    const result = await launch(home);
    assert.match(result.stdout, /nighttime: offline \(flash-next-solo-128k\)/);
    const text = await fs.readFile(file, 'utf8');
    assert.match(text, /!!js process.env.PRIVATE_FIXTURE # retain expression and comment/);
    assert.match(text, /Authorization: !!js process.env.PRIVATE_FIXTURE # retain provider expression/);
    const migrated = await rows(file);
    assert.deepEqual(config(migrated, 'agent-default-model'), selection === 'local-everyday'
      ? { ...selected, model: 'nighttime' } : selected);
    const next = config(migrated, 'llm-pi-ai').providers;
    assert.deepEqual(next['amazon-bedrock'], external);
    assert.equal(next['local-everyday'].residentState.label, 'Nighttime — offline (flash-next-solo-128k)');
    assert.equal(next['local-ollama'].models[0].contextWindow, 131072 - 1024);
    const after = await fs.stat(file);
    assert.equal(after.mode, stat.mode); assert.equal(after.uid, stat.uid); assert.equal(after.gid, stat.gid);
    assert.equal(await fs.readFile(session, 'utf8'), 'unchanged session history');
    const bytes = await fs.readFile(file, 'utf8');
    assert.match((await launch(home)).stdout, /already current/);
    assert.equal(await fs.readFile(file, 'utf8'), bytes, 'startup migration is idempotent');
    router.publish(paired());
    await launch(home);
    const restored = config(await rows(file), 'llm-pi-ai').providers['local-everyday'];
    assert.equal(restored.residentUnavailable, false);
    assert.equal(restored.residentState.status, 'available');
    assert.equal(restored.models[0].contextWindow, 98304 - 1024);
    assert.doesNotMatch(await fs.readFile(file, 'utf8'), /qwen3\.8|fixture-(?:day|night)time|local-active/);
  });
}

// A host runtime installed by an earlier image carries an older availability
// patch; the packaged CI runtime (DSH_TEST_HARNESS=1) always carries this one.
let adapterSource;
try { adapterSource = YAML && await fs.readFile(path.join(runtime, 'node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'), 'utf8'); } catch {}
const staleRuntime = Boolean(adapterSource?.includes('dsh-resident-availability-v1') && !adapterSource.includes('dsh-resident-availability-v2'));
if (staleRuntime && process.env.DSH_TEST_HARNESS === '1') throw new Error('the packaged runtime lacks the current availability patch');

test('real pinned adapter: unavailable placeholder, state messages, switching dispatch and legacy route IDs', { skip: !YAML ? true : staleRuntime ? 'installed runtime predates this availability patch; set DSH_RUNTIME_ROOT' : false }, async t => {
  const { patchAdapter } = await import('../scripts/patch-dsh-resident-availability.mjs');
  const { pathToFileURL } = await import('node:url');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'resident-adapter-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.symlink(path.join(runtime, 'node_modules'), path.join(temporary, 'node_modules'));
  const source = adapterSource;
  await fs.writeFile(path.join(temporary, 'adapter.mjs'), patchAdapter(source) + '\nexport { resolveProfiles };');
  const { Config, resolveProfiles, PiAiAdapter } = await import(pathToFileURL(path.join(temporary, 'adapter.mjs')));
  const offline = { service: 'nighttime', status: 'offline', label: 'Nighttime — offline (flash-next-solo-128k)',
    message: 'Nighttime is offline in router configuration "flash-next-solo-128k". Switch this session to Daytime.', configuration: 'flash-next-solo-128k', limits: 'stale' };
  const switching = { service: 'daytime', status: 'switching', label: 'Daytime — router switching configuration', limits: 'stale' };
  const config = Config({ providers: {
    'local-everyday': { api: 'openai-responses', baseURL: 'http://127.0.0.1:1/v1', residentUnavailable: true, residentState: offline,
      models: [{ id: 'nighttime', name: 'Nighttime' }] },
    'local-ollama': { api: 'openai-responses', baseURL: 'http://127.0.0.1:1/v1', residentUnavailable: false, residentState: switching,
      models: [{ id: 'daytime', name: 'Qwen3.8 27B Q6_K (160K)', contextWindow: 162816, input: ['text', 'image'] }] },
    'amazon-bedrock': { models: [{ id: 'amazon.nova-lite-v1:0' }] },
  } });
  const profiles = resolveProfiles(config.providers.get());
  const adapter = new PiAiAdapter({ profiles: () => profiles, auth: {} });
  const [night] = await adapter.listModels('local-everyday');
  assert.equal(night.available, false);
  assert.equal(night.name, 'Nighttime — offline (flash-next-solo-128k)');
  assert.throws(() => adapter.prepareCall('local-everyday', 'nighttime'), error => error.code === 'MODEL_UNAVAILABLE' && /Switch this session to Daytime/.test(error.message));
  const [day] = await adapter.listModels('local-ollama');
  assert.equal(day.available, true, 'a switching router does not block selection or dispatch');
  assert.equal(day.name, 'Daytime — router switching configuration');
  // Sessions recorded before service IDs still resolve, and send the service ID.
  const prepared = await adapter.prepareCall('local-ollama', 'local-active');
  assert.equal(prepared.model.id, 'local-active');
  assert.equal(prepared.model.context.contextWindow, 162816);
  assert.equal((await adapter.listModels('amazon-bedrock'))[0].id, 'amazon.nova-lite-v1:0');
});
