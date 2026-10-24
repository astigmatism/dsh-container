#!/usr/bin/env node
/** Verify persisted resident settings against the live router (docs/llm-router-contract.md).
 *
 * The router's current configuration never fails verification: an offline,
 * unavailable, incomplete or switching model is reported and skipped. What must
 * hold is that each model's recorded state, label and (when available) limits
 * match the capabilities document, and that only service IDs are configured.
 *
 * A router that is not answering is that same rule at route scale: the contract
 * keeps the last catalog and marks it stale rather than inventing a fallback, so
 * verification accepts a gated route whose every model is recorded as down, and
 * fails only when settings still offer a model the silent router cannot serve.
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
 * Compare a deployment's router routes with the capabilities documents their
 * routers publish. Each route must carry one model row per service its router
 * offers, with that document's titles, limits and state.
 * `allowLegacyIds` accepts settings written by releases that predate service
 * IDs (rollback verification); it checks identity and availability only.
 * An opt-in service (the trial) whose router offers nothing is reported and
 * skipped: the owner's current configuration is never a Harness failure.
 * @returns one row per configured model: provider, service, status and notice.
 */
export async function verifyConfiguredRoutes(settings, { browser = false, primaryBrowser = false, allowLegacyIds = false, log = () => {} } = {}) {
  const { ROUTER_PROVIDER, RETIRED_ROUTES, OPT_IN_SERVICES, routerServices, routerRouteState, residentLabel,
    residentStateRecord, routerModelName, requireRouterCapabilities, describeStatus, routerBaseOf, routerClientName, routerName,
    resolveProviderList, fetchCapabilities, isOptInService } = await loadRouterContract();
  const providers = settings?.['llm-pi-ai']?.providers;
  assert.ok(providers?.[ROUTER_PROVIDER], `missing ${ROUTER_PROVIDER} provider`);
  const selected = settings['agent-default-model'];
  const discovery = settings['router-model-discovery'];
  const clientName = routerClientName({ instance: discovery?.clientInstance });
  const optInServices = Array.isArray(discovery?.optInServices) && discovery.optInServices.length
    ? discovery.optInServices : OPT_IN_SERVICES;
  // Which routers to follow is the plugin's setting; without it, the one route
  // this release manages. A deployment's external providers are not routers.
  const routes = resolveProviderList(discovery?.providers);
  // Discovery retires these routes by rewriting what selects them and unsetting
  // the route, so one that is still configured means that migration has not run.
  // Rollback verification keeps the older answer, where naming a service as its
  // own route was the deployment's configuration.
  if (!allowLegacyIds) {
    for (const retired of Object.keys(RETIRED_ROUTES)) {
      assert.ok(!providers[retired],
        `provider ${retired} is retired: one route per router carries its catalog`);
    }
  }
  const documents = new Map();
  const rows = [];
  for (const name of routes) {
    const provider = providers[name];
    const optional = routes.length > 1;
    if (!provider) {
      const notice = `${name}: no route is configured; skipped (discovery provisions a route from the router it follows).`;
      if (optional) { log(notice); continue; }
      assert.fail(`${name}: no route is configured`);
    }
    assert.ok(provider.api === 'openai-responses', `provider ${name} is not using Responses`);
    assert.ok(Array.isArray(provider.models) && provider.models.length > 0, `provider ${name} configures no models`);
    if (!allowLegacyIds) {
      assert.equal(provider.headers?.['X-Client-Name'], clientName, `${name} does not identify itself with X-Client-Name`);
    }
    const base = routerBaseOf(provider.baseURL);
    if (!documents.has(base)) {
      try { documents.set(base, { document: (await fetchCapabilities(base, { clientName })).document }); }
      catch (error) { documents.set(base, { document: null, error: error.message }); }
    }
    const fetched = documents.get(base);
    const document = fetched.document;
    const configured = new Map((provider.models ?? []).map(row => [row.id, row]));
    const states = provider.residentStates ?? {};
    if (document === null) {
      // A router that is not answering is a state this contract defines (§5: no
      // fallback; §7: keep the last catalog and mark it stale), never a Harness
      // failure. What has to hold is that the route says so: gated, with every
      // model recorded as down, instead of offering a model nobody can serve.
      assert.equal(provider.residentUnavailable, true,
        `${name}: the router is not answering (${fetched.error}) and the route is not gated`);
      assert.equal(provider.residentState?.status, 'unavailable',
        `${name}: route state is not synchronized (the router is not answering: ${fetched.error})`);
      for (const model of provider.models ?? []) {
        const state = states[model.id];
        assert.ok(state?.status === 'unavailable' || state?.status === 'incomplete',
          `${name}/${model.id}: the router is not answering but the model still records ${state?.status ?? 'nothing'}`);
        rows.push({ provider: name, service: model.id, status: state.status,
          notice: `router not answering (${fetched.error}); recorded as ${state.status}` });
      }
      log(`${name}: the router is not answering (${fetched.error}); the route is gated and every model is recorded as `
        + 'unavailable — an unreachable router is a state, not a Harness failure.');
      continue;
    }
    const catalog = routerServices(document, { known: [...configured.keys()], optInServices });
    const route = routerRouteState(document);
    // The route is gated only by its router as a whole; each model answers for itself.
    const routeBlocked = route.status === 'unavailable' || route.status === 'incomplete';
    assert.equal(provider.residentUnavailable === true, routeBlocked,
      `${name}: route availability is not synchronized (router reports ${route.status}${route.reason ? `: ${route.reason}` : ''})`);
    assert.equal(provider.residentState?.status, route.status, `${name}: route state is not synchronized`);
    const capacity = new Map();
    for (const service of catalog.services) {
      const label = `${name}/${service.service}`;
      const model = configured.get(service.service);
      const state = states[service.service];
      const optIn = service.optIn === true;
      if (!model) {
        if (optIn && service.status !== 'available') {
          const notice = `${label}: ${describeStatus(service)}; skipped (opt-in service: discovery creates the row when the router offers it).`;
          log(notice);
          rows.push({ provider: name, service: service.service, status: service.status, notice, configured: false, optIn: true });
          continue;
        }
        assert.fail(`${label}: the router publishes it but the route configures no such model; discovery has not written it`);
      }
      if (!allowLegacyIds) assert.equal(model.id, service.service, `${label}: model id is not the service ID`);
      assert.equal(model.name, routerModelName(service, model.name), `${label} display name is not the title the router publishes`);
      assert.equal(state?.status, service.status, `${label} state is not synchronized (router reports ${describeStatus(service)})`);
      assert.equal(state?.label, residentStateRecord(service, model.name, { optInServices }).label, `${label} picker label is not synchronized`);
      if (service.status !== 'available') {
        const notice = `${label}: ${describeStatus(service)}; skipped${optIn ? ' (opt-in service, never selected automatically)' : ''} — the router's current configuration is not a Harness failure.`;
        log(notice);
        rows.push({ provider: name, service: service.service, status: service.status, notice, ...(optIn ? { optIn: true } : {}) });
        continue;
      }
      rows.push({ provider: name, service: service.service, status: service.status, ...(optIn ? { optIn: true } : {}) });
      if (!service.capabilities) {
        log(`${label}: served by a pre-contract router without published limits; stored limits kept.`);
        continue;
      }
      const capabilities = service.capabilities;
      assert.equal(model.contextWindow, capabilities.contextWindow, `${label} context is not synchronized`);
      assert.equal(model.maxTokens, capabilities.maxTokens, `${label} output policy is not synchronized`);
      assert.deepEqual([...model.input].sort(), [...capabilities.input].sort(), `${label} modalities are not synchronized`);
      assert.deepEqual(model.reasoningEfforts, capabilities.reasoningEfforts, `${label} effort mapping is not synchronized`);
      const modelOf = nonEmptyName(service.served) ? service.served : service.service;
      capacity.set(modelOf, Math.max(capacity.get(modelOf) ?? 0, capabilities.maxConcurrency));
      // Browser capability is checked for the model a browser session actually
      // uses: the saved selection, or what the router calls its default.
      const browserRoute = name === ROUTER_PROVIDER || selected?.provider === name;
      const browserModel = (selected?.provider === name ? selected.model : undefined) ?? provider.residentState?.default;
      if (!browserRoute || browserModel !== service.service) continue;
      requireRouterCapabilities(service.model?.metadata, {
        browser: browser || primaryBrowser,
        effort: selected?.provider === name && selected.model === service.service
          ? selected.reasoningEffort : provider.reasoning,
      });
    }
    const slots = [...capacity.values()].reduce((total, count) => total + count, 0);
    if (slots > 0) {
      assert.equal(provider.maxConcurrency, slots,
        `${name}: concurrency is not the slots of the models it offers (offered ${slots})`);
    }
    // A router that publishes no name of its own is titled by the address it
    // answers at; with no document at all there is nothing to compare against.
    const published = routerName(document, provider.baseURL);
    if (published !== undefined) {
      assert.equal(provider.displayName, published, `${name} is not titled with the name the router publishes`);
    }
  }
  return rows;
}

const nonEmptyName = value => typeof value === 'string' && value.length > 0;

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
 * before using them, or use the persisted states during an offline image build.
 * A row is marked `optIn` when only a human may select that model; verification
 * shows it in the catalog and picker but never selects it or sends inference. */
export async function residentClientExpectations(settings, { live = true, log } = {}) {
  if (live) await verifyConfiguredRoutes(settings, { primaryBrowser: true, log });
  const { ROUTER_PROVIDER, resolveProviderList, OPT_IN_SERVICES, isOptInService } = await loadRouterContract();
  const providers = settings?.['llm-pi-ai']?.providers;
  assert.ok(providers);
  const discovery = settings['router-model-discovery'];
  const optInServices = Array.isArray(discovery?.optInServices) && discovery.optInServices.length
    ? discovery.optInServices : OPT_IN_SERVICES;
  const rows = [];
  for (const provider of resolveProviderList(discovery?.providers)) {
    const source = providers[provider];
    if (!source) {
      assert.fail(`provider ${provider} is missing`);
    }
    const states = source.residentStates ?? {};
    for (const configured of source.models ?? []) {
      const model = configured.id;
      const optIn = isOptInService(model, optInServices);
      assert.ok(typeof configured.name === 'string' && configured.name.length > 0, `${provider}/${model}: model has no display name`);
      const state = states[model];
      const blocked = source.residentUnavailable === true
        || state?.status === 'offline' || state?.status === 'unavailable' || state?.status === 'incomplete';
      if (blocked) {
        rows.push({ provider, model, name: state?.label ?? `${model} — unavailable`, available: false,
          status: state?.status ?? (source.residentUnavailable ? source.residentState?.status : undefined) ?? 'unavailable',
          recorded: state !== undefined, ...(optIn ? { optIn: true } : {}) });
        continue;
      }
      assert.ok(Number.isSafeInteger(configured.contextWindow) && configured.contextWindow > 0,
        `${provider}/${model}: an available model needs a context window`);
      const name = state?.status && state.status !== 'available' ? state.label : configured.name;
      rows.push({ provider, model, available: true, status: state?.status ?? 'available', name,
        contextWindow: configured.contextWindow, reasoningEffort: source.reasoning, ...(optIn ? { optIn: true } : {}) });
    }
  }
  return rows;
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
