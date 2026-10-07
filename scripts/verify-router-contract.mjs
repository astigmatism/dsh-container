#!/usr/bin/env node
/** Verify persisted resident settings against the live router (docs/llm-router-contract.md).
 *
 * The router's current configuration never fails verification: an offline,
 * unavailable, incomplete or switching model is reported and skipped. What must
 * hold is that each model's recorded state, label and (when available) limits
 * match the capabilities document, and that only service IDs are configured.
 */
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

/**
 * Compare configured resident routes with the current capabilities document.
 * `allowLegacyIds` accepts settings written by releases that predate service
 * IDs (rollback verification); it checks identity and availability only.
 * @returns one row per resident: provider, service, status and notice.
 */
export async function verifyConfiguredRoutes(settings, { browser = false, primaryBrowser = false, allowLegacyIds = false, log = () => {} } = {}) {
  const { RESIDENT_SERVICES, residentStatus, fetchCapabilities, routerClientName, residentLabel, residentStateRecord,
    requireRouterCapabilities, isBlockingStatus, describeStatus, routerBaseOf } = await loadRouterContract();
  const providers = settings?.['llm-pi-ai']?.providers;
  assert.ok(providers?.['local-ollama'], 'missing local-ollama provider');
  const selected = settings['agent-default-model'];
  const discovery = settings['router-model-discovery'];
  const clientName = routerClientName({ instance: discovery?.clientInstance });
  const documents = new Map();
  const rows = [];
  for (const [name, service] of Object.entries(RESIDENT_SERVICES)) {
    const provider = providers[name];
    assert.ok(provider && Array.isArray(provider.models) && provider.models.length === 1, `provider ${name} must configure exactly one model`);
    assert.equal(provider.api, 'openai-responses', `provider ${name} is not using Responses`);
    const configured = provider.models[0].id;
    if (!allowLegacyIds) {
      assert.equal(configured, service, `${name} must send the router service ID "${service}", not "${configured}"`);
      assert.equal(provider.headers?.['X-Client-Name'], clientName, `${name} does not identify itself with X-Client-Name`);
    }
    const base = routerBaseOf(provider.baseURL);
    if (!documents.has(base)) documents.set(base, (await fetchCapabilities(base, { clientName })).document);
    const document = documents.get(base);
    const state = residentStatus(document, service);
    const label = `${name}/${service}`;
    if (configured !== service) {
      // Pre-service-ID releases: the stored ID must still reach the same model.
      assert.ok(state.status !== 'available' || document.ids?.[configured] === document.ids?.[service],
        `${label}: legacy ID "${configured}" no longer reaches the ${service} service`);
    }
    assert.equal(provider.residentUnavailable === true, isBlockingStatus(state.status),
      `${label} availability is not synchronized (router reports ${describeStatus(state)})`);
    if (!allowLegacyIds || provider.residentState !== undefined) {
      assert.equal(provider.residentState?.status, state.status, `${label} state is not synchronized (router reports ${describeStatus(state)})`);
      assert.equal(provider.residentState?.label, residentStateRecord(state, provider.models[0].name).label, `${label} picker label is not synchronized`);
    }
    if (state.status !== 'available') {
      const notice = `${service}: ${describeStatus(state)}; skipped (the router's current configuration is not a Harness failure).`;
      log(notice);
      rows.push({ provider: name, service, status: state.status, notice });
      continue;
    }
    if (!state.capabilities) {
      const notice = `${service}: served by a pre-contract router without published limits; stored limits kept.`;
      log(notice);
      rows.push({ provider: name, service, status: state.status, notice });
      continue;
    }
    requireRouterCapabilities(state.metadata, {
      browser: (browser && (name === 'local-ollama' || selected?.provider === name)) || (primaryBrowser && name === 'local-ollama'),
      effort: (browser && selected?.provider === name ? selected.reasoningEffort : undefined) ?? provider.reasoning,
    });
    rows.push({ provider: name, service, status: state.status });
    if (allowLegacyIds && configured !== service) continue;
    const model = provider.models[0];
    const capabilities = state.capabilities;
    assert.equal(model.contextWindow, capabilities.contextWindow, `${label} context is not synchronized`);
    assert.equal(model.name, residentLabel(state), `${label} display name is not synchronized`);
    if (capabilities.displayName) assert.equal(provider.displayName, capabilities.displayName, `${label} provider name is not synchronized`);
    assert.equal(model.maxTokens, capabilities.maxTokens, `${label} output policy is not synchronized`);
    assert.equal(provider.maxConcurrency, capabilities.maxConcurrency, `${label} concurrency is not synchronized`);
    assert.deepEqual([...model.input].sort(), [...capabilities.input].sort(), `${label} modalities are not synchronized`);
    assert.deepEqual(model.reasoningEfforts, capabilities.reasoningEfforts, `${label} effort mapping is not synchronized`);
  }
  return rows;
}

export async function readSettings(file) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT' || !file.endsWith('/settings.yaml')) throw error;
    text = await readFile(file.slice(0, -'settings.yaml'.length) + 'profiles/web/cordis.patch.yml', 'utf8');
  }
  if (file.endsWith('.json')) return JSON.parse(text);
  const require = createRequire(`${process.env.DSH_RUNTIME_ROOT ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh'}/package.json`);
  const value = require('yaml').parse(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
  if (!Array.isArray(value)) return value;
  const settings = {};
  for (const row of value) if (row.id && row.config) settings[row.id] = { ...settings[row.id], ...row.config };
  return settings;
}

/** Independent expected UI contract: validate live settings against discovery
 * before using them, or use the persisted states during an offline image build. */
export async function residentClientExpectations(settings, { live = true, log } = {}) {
  if (live) await verifyConfiguredRoutes(settings, { primaryBrowser: true, log });
  const { RESIDENT_SERVICES } = await loadRouterContract();
  const providers = settings?.['llm-pi-ai']?.providers;
  assert.ok(providers);
  return Object.entries(RESIDENT_SERVICES).map(([provider, model]) => {
    const source = providers[provider];
    assert.deepEqual(source.models?.map(row => row.id), [model]);
    const configured = source.models[0];
    assert.ok(typeof configured.name === 'string' && configured.name.length > 0);
    const state = source.residentState;
    if (source.residentUnavailable === true) {
      return { provider, model, name: state?.label ?? `${model === 'nighttime' ? 'Nighttime' : 'Daytime'} — unavailable`, available: false,
        status: state?.status ?? 'unavailable', recorded: state !== undefined };
    }
    assert.ok(Number.isSafeInteger(configured.contextWindow) && configured.contextWindow > 0);
    const name = state?.status && state.status !== 'available' ? state.label : configured.name;
    return { provider, model, available: true, status: state?.status ?? 'available', name, contextWindow: configured.contextWindow,
      reasoningEffort: source.reasoning, recorded: state !== undefined };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const settingsIndex = args.indexOf('--settings');
    const path = settingsIndex >= 0 ? args[settingsIndex + 1] : '/data/dsh/settings.yaml';
    await verifyConfiguredRoutes(await readSettings(path), { browser: args.includes('--browser'),
      primaryBrowser: args[args.indexOf('--mode') + 1] === 'remote', log: message => console.log(message) });
    console.log(`Verified ${args.includes('--browser') ? 'selected browser capabilities and' : 'configured router'} model contracts against the router capabilities document.`);
  } catch (error) {
    console.error(`Router provider verification failed: ${error.message}`);
    process.exitCode = 22;
  }
}
