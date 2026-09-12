#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const sourcePath = process.env.DSH_ROUTER_PLUGIN_PATH ?? new URL('../seed/plugins/dsh-router-model-discovery.js', import.meta.url);
export async function loadRouterContract() {
  let source;
  try { source = await readFile(sourcePath, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    source = await readFile('/opt/dsh-seed/.dsh-plugins/dsh-router-model-discovery.js', 'utf8');
  }
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

export async function verifyConfiguredRoutes(settings, { browser = false, primaryBrowser = false } = {}) {
  const { resolveRouterEntry, routerMetadataOf, fetchRouterCatalog, requireRouterCapabilities, dshReasoningEfforts } = await loadRouterContract();
  const providers = settings?.['llm-pi-ai']?.providers;
  assert.ok(providers?.['local-ollama'], 'missing local-ollama provider');
  const selected = settings['agent-default-model'];
  const names = browser ? [selected?.provider ?? 'local-ollama'] : ['local-ollama', ...('local-everyday' in providers ? ['local-everyday'] : [])];
  const catalogs = new Map();
  for (const name of names) {
    const provider = providers[name];
    assert.ok(provider && Array.isArray(provider.models) && provider.models.length, `provider ${name} has no configured models`);
    assert.equal(provider.api, 'openai-responses', `provider ${name} is not using Responses`);
    if (!catalogs.has(provider.baseURL)) catalogs.set(provider.baseURL, await fetchRouterCatalog(provider.baseURL));
    const models = browser ? provider.models.filter(model => model.id === (selected?.model ?? 'local-active')) : provider.models;
    assert.ok(models.length, 'selected browser model is not configured');
    for (const model of models) {
      const metadata = routerMetadataOf(resolveRouterEntry(catalogs.get(provider.baseURL), model.id));
      requireRouterCapabilities(metadata, { browser: browser || (primaryBrowser && name === "local-ollama"), effort: (browser ? selected?.reasoningEffort : undefined) ?? provider.reasoning });
      const label = `${name}/${model.id}`;
      assert.equal(model.contextWindow, metadata.context_window, `${label} context is not synchronized`);
      assert.equal(model.maxTokens, metadata.max_output_tokens, `${label} output policy is not synchronized`);
      assert.equal(provider.maxConcurrency, metadata.active_request_limit, `${label} concurrency is not synchronized`);
      assert.deepEqual([...model.input].sort(), [...metadata.input_modalities].sort(), `${label} modalities are not synchronized`);
      assert.deepEqual(model.reasoningEfforts, dshReasoningEfforts(metadata.reasoning), `${label} effort mapping is not synchronized`);
    }
  }
}

export async function readSettings(file) {
  const text = await readFile(file, 'utf8');
  if (file.endsWith('.json')) return JSON.parse(text);
  const require = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
  return require('yaml').parse(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const settingsIndex = args.indexOf('--settings');
    const path = settingsIndex >= 0 ? args[settingsIndex + 1] : '/data/dsh/settings.yaml';
    await verifyConfiguredRoutes(await readSettings(path), { browser: args.includes('--browser'), primaryBrowser: args[args.indexOf('--mode') + 1] === 'remote' });
    console.log(`Verified ${args.includes('--browser') ? 'selected browser capabilities and' : 'configured router'} model contracts against complete schema-v2 discovery.`);
  } catch (error) {
    console.error(`Router provider verification failed: ${error.message}`);
    process.exitCode = 22;
  }
}
