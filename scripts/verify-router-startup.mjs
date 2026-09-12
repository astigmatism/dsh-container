#!/usr/bin/env node
/** Exercise deterministic migration through the real entrypoint in a throwaway home. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readSettings, verifyConfiguredRoutes } from './verify-router-contract.mjs';
const exec = promisify(execFile);
const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-router-startup-'));
const runtime = path.join(parent, 'runtime');
const primaryId = 'qwen3.8-27b-q8_0';
const secondaryId = 'qwen3.8-27b-abliterated-q6_k';
const entries = [primaryId, secondaryId].map((id, index) => ({ id, x_ollama_router: {
  schema_version: 2, complete: true, warnings: [], alias: false, upstream_model: id,
  aliases: index ? [] : ['local-active'], display_name: index ? 'Secondary fixture' : 'Primary fixture',
  context_window: index ? 32768 : 131072, active_request_limit: 1,
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
try {
  await fs.symlink('/opt/dsh-local-speech', path.join(parent, 'dsh-local-speech'));
  await exec('/usr/local/bin/dsh-sync-runtime-profile', { env: { ...process.env, DSH_HOME: runtime } });
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
  child = spawn('/usr/local/bin/dsh-entrypoint', [], {
    cwd: parent, detached: true, env: { ...process.env, DSH_HOME: runtime, DSH_TELEMETRY_DISABLED: '1', STARTUP_FIXTURE_KEY: 'fixture-only' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { bootLog += chunk; });
  child.stderr.on('data', chunk => { bootLog += chunk; });
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
      assert.deepEqual(current['llm-pi-ai'].providers['unrelated-fixture'], settings['llm-pi-ai'].providers['unrelated-fixture']);
      assert.equal(current['llm-pi-ai'].providers['local-ollama'].apiKeyEnv, 'STARTUP_FIXTURE_KEY');
      assert.equal(current['llm-pi-ai'].providers['local-ollama'].reasoning, 'medium');
      assert.equal(current['llm-pi-ai'].providers['local-everyday'].reasoning, 'medium');
      assert.equal((await fs.stat(settingsPath)).mode & 0o777, 0o600);
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
} catch (error) {
  // This isolated home contains synthetic settings only; strip launch URLs.
  const diagnostic = bootLog.split('\n').slice(-30).map(line => line.replace(/https?:\/\/\S+/g, '[endpoint]').replace(/fixture-only[^\s]*/g, '[fixture value]')).join('\n');
  throw new Error(`${error.message.replace(/https?:\/\/\S+/g, '[endpoint]')}${diagnostic ? '\n' + diagnostic : ''}`);
} finally {
  if (child?.pid) {
    const closed = new Promise(resolve => child.once('close', resolve));
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 1000))]);
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(parent, { recursive: true, force: true });
}
