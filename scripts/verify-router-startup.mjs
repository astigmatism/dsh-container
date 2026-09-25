#!/usr/bin/env node
/** Exercise deterministic migration through the real entrypoint in a throwaway home. */
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
const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-router-startup-'));
const runtime = path.join(parent, 'runtime');
const tokenIndexPath = path.join(runtime, 'storages/dsh_token_index.json');
const tokenIndex = JSON.stringify({ unit: { name: 'dsh_token_index', version: 1 },
  global: { v: 1, data: { tz: 'UTC', foldVersion: 1, builtAt: 1 } }, tables: { shards: {} } });
const primaryId = 'qwen3.8-27b-q8_0';
const secondaryId = 'qwen3.8-27b-abliterated-q6_k';
const entries = [primaryId, secondaryId].map((id, index) => ({ id, x_ollama_router: {
  schema_version: 2, complete: true, warnings: [], alias: false, upstream_model: id,
  aliases: index ? [] : ['local-active'], display_name: index ? 'Secondary fixture' : 'Primary fixture',
  context_window: 131072, active_request_limit: 1,
  output_policy: 'unrestricted', max_output_tokens: null, default_output_tokens: null,
  input_modalities: index ? ['text'] : ['text', 'image'],
  capabilities: index ? ['completion', 'thinking'] : ['completion', 'thinking', 'tools', 'vision'],
  health: { available: true, status: 200 }, reasoning: {
    supported: true, default: 'default', output_limit_policy: 'reject', absolute_max_output_tokens: null,
    efforts: { default: 'default', off: 'none', low: 'low', medium: 'medium', xhigh: 'xhigh' },
    aliases: { minimal: 'low', high: 'xhigh', max: 'xhigh' },
    per_effort: Object.fromEntries(['default', 'off', 'low', 'medium', 'xhigh'].map(level => [level, {
      enabled: level !== 'off', default_output_tokens: null, max_output_tokens: null
    }]))
  }
}}));
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ data: entries }));
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
  const settings = {
    'agent-default-model': { provider: 'local-ollama-256k', model: 'local-active', reasoningEffort: 'off' },
    'permission': { defaultPreset: 'danger-full-access' },
    'ui-onboarding': { welcomeNoticeVersion: '2026-08-13.1' },
    'llm-pi-ai': { providers: {
      'local-ollama': provider,
      'local-ollama-256k': { ...structuredClone(provider), maxConcurrency: 1 },
      'unrelated-fixture': { ...structuredClone(provider), baseURL: 'http://unrelated.invalid/v1', reasoning: 'low' }
    }}
  };
  const settingsPath = path.join(runtime, 'settings.yaml');
  await fs.writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  start();
  // No browser or agent creation: migration must complete before DSH launches.
  let lastError;
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw new Error('Harness exited during router startup qualification');
    try {
      const current = await readSettings(settingsPath);
      await verifyConfiguredRoutes(current, { primaryBrowser: true });
      assert.ok(current['llm-pi-ai'].providers['local-everyday']);
      assert.equal(current['llm-pi-ai'].providers['local-ollama-256k'], undefined);
      assert.deepEqual(current['agent-default-model'], { provider: 'local-ollama', model: 'local-active', reasoningEffort: 'off' });
      assert.deepEqual(Object.keys(current['llm-pi-ai'].providers).sort(), ['local-everyday', 'local-ollama']);
      assert.equal(current['llm-pi-ai'].providers['local-ollama'].apiKeyEnv, 'STARTUP_FIXTURE_KEY');
      assert.equal(current['llm-pi-ai'].providers['local-ollama'].reasoning, 'medium');
      assert.equal(current['llm-pi-ai'].providers['local-everyday'].reasoning, 'medium');
      const migratedPath = path.join(runtime, 'profiles/web/cordis.patch.yml');
      assert.equal((await fs.stat(migratedPath)).mode & 0o777, 0o600);
      await fs.access(path.join(runtime, '.container-settings-v1.json'));
      assert.equal((await fs.readdir(runtime)).some(name => name.includes('before-residents') || name.includes('.resident-')), false);
      const before = JSON.stringify(current);
      await new Promise(resolve => setTimeout(resolve, 500));
      assert.equal(JSON.stringify(await readSettings(settingsPath)), before);
      console.log('Real Harness entrypoint migrated legacy providers before agent activation; null limits, target capabilities and explicit preferences verified.');
      lastError = undefined;
      break;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (lastError) throw lastError;
  await authenticate();
  await rpc('settings/update', { ns: 'agent-default-model', patch: { reasoningEffort: 'low' } });
  await rpc('settings/update', { ns: 'better-sidebar', patch: { tabsEnabled: { subagent: false, sidechat: true } } });
  const retained = await rpc('settings/describe');
  const model = retained.namespaces.find(row => row.ns === 'agent-default-model').value;
  const sidebar = retained.namespaces.find(row => row.ns === 'better-sidebar').value;
  assert.equal(model.reasoningEffort, 'low');
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
    const inventory = await rpc('pluginInventory/list');
    const token = inventory.entries.find(row => row.moduleName === '@zoytown/dsh-token');
    assert.equal(token.enabled, false);
    assert.notEqual(token.fiberPhase, 'active');
    assert.equal(await fs.readFile(tokenIndexPath, 'utf8'), tokenIndex, 'disabled Token index bytes');
    const tokenIndexAfter = await fs.stat(tokenIndexPath);
    assert.equal(tokenIndexAfter.mtimeMs, tokenIndexBefore.mtimeMs, 'disabled Token index was not rewritten');
    assert.equal(tokenIndexAfter.ino, tokenIndexBefore.ino, 'disabled Token index was not replaced');
  }
  console.log('Settings saved through the rc2 API, model choice, plugin preferences and credential references survived two complete entrypoint restarts; Token stayed unloaded and its index stayed unchanged.');

} catch (error) {
  // This isolated home contains synthetic settings only; strip launch URLs.
  const diagnostic = bootLog.split('\n').slice(-30).map(line => line.replace(/https?:\/\/\S+/g, '[endpoint]').replace(/fixture-only[^\s]*/g, '[fixture value]')).join('\n');
  throw new Error(`${error.message.replace(/https?:\/\/\S+/g, '[endpoint]')}${diagnostic ? '\n' + diagnostic : ''}`);
} finally {
  await stop();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(parent, { recursive: true, force: true });
}
