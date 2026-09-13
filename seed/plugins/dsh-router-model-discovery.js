/** Synchronize two resident model choices from public router metadata.
 * Coding retains local-active for existing agents; everyday uses its real ID.
 */

export const name = "router-model-discovery";

const DSH_REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const DSH_INPUT_MODALITIES = new Set(["text", "image"]);
const DEFAULT_PROVIDERS = ["local-ollama", "local-everyday"];
const PROVIDER_PRESENTATION = new Map([
  ["local-ollama", {
    displayName: "Daytime (160K)",
    modelName: "Daytime (160K)",
    contextWindow: 163840,
    maxConcurrency: 1,
  }],
  ["local-everyday", {
    displayName: "Nighttime (128K)",
    modelName: "Nighttime (128K)",
    contextWindow: 131072,
    maxConcurrency: 1,
  }],
]);
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MIN_POLL_INTERVAL_MS = 5_000;

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Validate the public router extension before any of it reaches DSH settings.
 * Unknown fields are allowed so schema v2 can grow compatibly.
 */
export function routerMetadataOf(entry) {
  const metadata = entry?.x_ollama_router;
  if (!plainObject(metadata) || metadata.schema_version !== 2 || metadata.complete !== true) {
    throw new Error("router discovery metadata is not a complete schema-v2 document");
  }
  if (!Array.isArray(metadata.warnings) || metadata.warnings.length) throw new Error("router discovery metadata has warnings");
  for (const field of ["context_window", "active_request_limit"]) {
    if (!positiveInteger(metadata[field])) throw new Error(`router discovery metadata has no valid ${field}`);
  }
  if (metadata.health !== undefined && (!plainObject(metadata.health) || metadata.health.available !== true)) {
    throw new Error("router model backend is unavailable");
  }
  for (const field of ["input_modalities", "capabilities"]) {
    if (!Array.isArray(metadata[field]) || !metadata[field].length || metadata[field].some(value => !nonEmptyString(value))) {
      throw new Error(`router discovery metadata has invalid ${field}`);
    }
  }
  if (!metadata.input_modalities.includes("text") || metadata.input_modalities.includes("image") !== metadata.capabilities.includes("vision")) {
    throw new Error("router discovery metadata has inconsistent input capabilities");
  }
  const unrestricted = metadata.output_policy === "unrestricted";
  if (!unrestricted && ![undefined, "legacy", "bounded"].includes(metadata.output_policy)) {
    throw new Error("router discovery metadata has an unknown output_policy");
  }
  if (unrestricted
    ? metadata.max_output_tokens !== null || metadata.default_output_tokens !== null
    : !positiveInteger(metadata.max_output_tokens) || (metadata.default_output_tokens !== undefined &&
      (!positiveInteger(metadata.default_output_tokens) || metadata.default_output_tokens > metadata.max_output_tokens))) {
    throw new Error("router discovery metadata has invalid output limits");
  }
  const reasoning = metadata.reasoning;
  if (!plainObject(reasoning) || typeof reasoning.supported !== "boolean") throw new Error("router discovery metadata has no definitive reasoning capability");
  if (reasoning.supported !== metadata.capabilities.includes("thinking")) throw new Error("router discovery metadata has inconsistent reasoning capability");
  if (!plainObject(reasoning.efforts) || !plainObject(reasoning.aliases) || !plainObject(reasoning.per_effort)) {
    throw new Error("router discovery metadata has incomplete reasoning maps");
  }
  if (!['cap', 'reject'].includes(reasoning.output_limit_policy)) throw new Error("router discovery metadata has an invalid output_limit_policy");
  if (unrestricted ? reasoning.absolute_max_output_tokens !== null : !positiveInteger(reasoning.absolute_max_output_tokens)) {
    throw new Error("router discovery metadata has no valid absolute reasoning output limit");
  }
  if (reasoning.absolute_max_output_tokens !== metadata.max_output_tokens) throw new Error("router discovery metadata has inconsistent output limits");
  for (const [level, wire] of Object.entries(reasoning.efforts)) {
    if (!nonEmptyString(level) || !nonEmptyString(wire) || !plainObject(reasoning.per_effort[level])) {
      throw new Error(`router discovery metadata has an invalid reasoning effort "${level}"`);
    }
    const limits = reasoning.per_effort[level];
    if (typeof limits.enabled !== "boolean" || (unrestricted
      ? limits.default_output_tokens !== null || limits.max_output_tokens !== null
      : !positiveInteger(limits.default_output_tokens) || !positiveInteger(limits.max_output_tokens) ||
        limits.default_output_tokens > limits.max_output_tokens || limits.max_output_tokens > reasoning.absolute_max_output_tokens)) {
      throw new Error(`router discovery metadata has invalid limits for reasoning effort "${level}"`);
    }
  }
  for (const [alias, target] of Object.entries(reasoning.aliases)) {
    if (!nonEmptyString(alias) || !nonEmptyString(target) || !Object.hasOwn(reasoning.efforts, target)) {
      throw new Error(`router discovery metadata has an invalid reasoning alias "${alias}"`);
    }
  }
  if (reasoning.supported === true) {
    const target = reasoning.aliases[reasoning.default] ?? reasoning.default;
    if (!nonEmptyString(reasoning.default) || !Object.hasOwn(reasoning.efforts, target)) {
      throw new Error("router discovery metadata reasoning default is not supported");
    }
  }
  return metadata;
}

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
}

/** Resolve singleton aliases, canonical-only catalogs and explicit alias rows. */
export function resolveRouterEntry(body, modelId) {
  if (!Array.isArray(body?.data) || !body.data.length) throw new Error("router discovery has no model catalog");
  const exact = body.data.filter(entry => entry?.id === modelId);
  const targets = body.data.filter(entry => entry?.id !== modelId && entry?.x_ollama_router?.alias !== true && entry?.x_ollama_router?.aliases?.includes(modelId));
  if (exact.length > 1 || targets.length > 1) throw new Error(`ambiguous router model identity: ${modelId}`);
  const entry = exact[0] ?? targets[0];
  if (!entry) {
    const error = new Error(`router model is not advertised: ${modelId}`);
    error.code = "ROUTER_MODEL_NOT_FOUND";
    throw error;
  }
  if (exact[0]) {
    const meta = entry.x_ollama_router;
    const target = targets[0] ?? (meta?.alias === true ? body.data.find(row => row.id === meta.upstream_model && row.id !== modelId) : undefined);
    if (target) {
      const { alias: _alias, ...aliasMetadata } = meta;
      const { alias: _canonical, ...canonicalMetadata } = target.x_ollama_router;
      if (meta?.alias !== true || meta.upstream_model !== target.id || !sameJson(ordered(aliasMetadata), ordered(canonicalMetadata))) {
        throw new Error(`router alias metadata disagrees with its target: ${modelId}`);
      }
    }
  }
  return entry;
}

export async function fetchRouterCatalog(baseURL, signal = AbortSignal.timeout(10_000)) {
  let endpoint;
  try { endpoint = new URL(baseURL); } catch { throw new Error("router provider baseURL is invalid"); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error("router provider baseURL must use HTTP(S) without embedded credentials");
  }
  const response = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, { headers: { accept: "application/json" }, signal });
  if (!response.ok) throw new Error(`router discovery returned HTTP ${response.status}`);
  return response.json();
}

export function requireRouterCapabilities(metadata, { browser = false, effort } = {}) {
  if (browser) {
    for (const capability of ["vision", "tools"]) {
      if (!metadata.capabilities.includes(capability)) throw new Error(`selected browser route is missing ${capability} capability`);
    }
  }
  if (effort !== undefined) {
    const mapped = dshReasoningEfforts(metadata.reasoning);
    if (!mapped || !Object.hasOwn(mapped, effort)) throw new Error(`selected route does not support configured reasoning effort: ${effort}`);
  }
}

/** Translate the router vocabulary into dsh-llm-pi-ai's fixed selector levels. */
export function dshReasoningEfforts(reasoning) {
  if (reasoning.supported === false) return false;
  const mapped = {};
  for (const level of DSH_REASONING_LEVELS) {
    if (nonEmptyString(reasoning.efforts[level])) {
      mapped[level] = reasoning.efforts[level];
      continue;
    }
    const target = reasoning.aliases[level];
    if (nonEmptyString(target) && nonEmptyString(reasoning.efforts[target])) {
      // Keep the DSH selector alias, but send the router's canonical native wire
      // value (for example, the user-facing max choice is sent as xhigh).
      mapped[level] = reasoning.efforts[target];
    }
  }
  if (!Object.keys(mapped).some((level) => level !== "off")) {
    throw new Error("router reasoning metadata exposes no DSH-selectable enabled effort");
  }
  return mapped;
}

/** Seed a newly introduced repository profile from the working local route. */
export function provisionProviderOps(settings, providerName, modelId, storedSettings = settings) {
  const providers = settings?.providers;
  if (!plainObject(providers) || providers[providerName] !== undefined) return [];
  const presentation = PROVIDER_PRESENTATION.get(providerName);
  if (presentation === undefined || providerName === "local-ollama") return [];
  const resolvedSource = providers["local-ollama"];
  const storedSource = storedSettings?.providers?.["local-ollama"];
  const source = plainObject(storedSource) && Array.isArray(storedSource.models)
    ? storedSource
    : resolvedSource;
  if (!plainObject(source) || !Array.isArray(source.models)) {
    throw new Error(`cannot provision DSH provider "${providerName}" without local-ollama`);
  }
  const modelIndex = source.models.findIndex((model) => model?.id === "local-active" || model?.id === "qwen3.8-27b-q8_0");
  if (modelIndex < 0) {
    throw new Error(`cannot provision DSH provider "${providerName}" without model "${modelId}"`);
  }
  const models = [{
    ...source.models[modelIndex],
    id: modelId,
    name: presentation.modelName,
    contextWindow: presentation.contextWindow,
  }];
  return [{
    op: "set",
    path: ["providers", providerName],
    value: {
      ...source,
      displayName: presentation.displayName,
      maxConcurrency: presentation.maxConcurrency,
      models,
    },
  }];
}

/** Converge one configured route on its profile and the shared router contract. */
export function capabilityOps(settings, providerName, modelId, metadata, storedSettings = settings) {
  const provider = settings?.providers?.[providerName];
  const models = provider?.models;
  if (!Array.isArray(models)) throw new Error(`DSH provider "${providerName}" has no configured models`);
  const modelIndex = models.findIndex((model) => model?.id === modelId);
  if (modelIndex < 0) throw new Error(`DSH provider "${providerName}" has no model "${modelId}"`);

  const model = models[modelIndex];
  const input = metadata.input_modalities.filter((value) => DSH_INPUT_MODALITIES.has(value));
  if (input.length === 0) throw new Error("router advertises no input modality DSH can represent");
  const reasoningEfforts = dshReasoningEfforts(metadata.reasoning);
  const presentation = nonEmptyString(metadata.display_name)
    ? { displayName: metadata.display_name, modelName: metadata.display_name }
    : PROVIDER_PRESENTATION.get(providerName);
  const contextWindow = metadata.context_window;
  const maxConcurrency = metadata.active_request_limit;
  const operations = [];
  if (presentation !== undefined && provider.displayName !== presentation.displayName) {
    operations.push({
      op: "set",
      path: ["providers", providerName, "displayName"],
      value: presentation.displayName,
    });
  }
  if (provider.maxConcurrency !== maxConcurrency) {
    operations.push({
      op: "set",
      path: ["providers", providerName, "maxConcurrency"],
      value: maxConcurrency,
    });
  }
  // Keep explicit client policy separate from the router's raw default.
  if (provider.reasoning === undefined && reasoningEfforts?.medium) {
    operations.push({ op: "set", path: ["providers", providerName, "reasoning"], value: "medium" });
  }

  const modelCurrent =
    (presentation === undefined || model.name === presentation.modelName) &&
    model.contextWindow === contextWindow &&
    model.maxTokens === metadata.max_output_tokens &&
    sameJson(model.input, input) &&
    sameJson(model.reasoningEfforts, reasoningEfforts);
  if (modelCurrent) return operations;

  // SettingsPathOp descends through plain objects, not arrays. Replace the
  // stored provider models array atomically. Prefer the raw user-layer rows so
  // schema defaults from the resolved view are not materialized incidentally.
  const storedModels = storedSettings?.providers?.[providerName]?.models;
  const sourceModels = Array.isArray(storedModels) && storedModels.some((candidate) => candidate?.id === modelId)
    ? storedModels
    : models;
  const sourceIndex = sourceModels.findIndex((candidate) => candidate?.id === modelId);
  const nextModels = sourceModels.map((candidate, index) =>
    index === sourceIndex
      ? {
          ...candidate,
          ...(presentation === undefined ? {} : { name: presentation.modelName }),
          contextWindow,
          maxTokens: metadata.max_output_tokens,
          input,
          reasoningEfforts,
        }
      : candidate,
  );
  operations.push({
    op: "set",
    path: ["providers", providerName, "models"],
    value: nextModels,
  });
  return operations;
}

/** The same synchronization is used by startup and the optional offline migration. */
export async function synchronizeRouterSettings(settingsService, providers = DEFAULT_PROVIDERS) {
  const initial = settingsService.get("llm-pi-ai");
  if (!plainObject(initial)) throw new Error('DSH settings namespace "llm-pi-ai" is not registered yet');
  const catalogs = new Map();
  const plans = [];
  // Fetch and validate every selected contract before provisioning any provider.
  for (const providerName of providers) {
    const provider = initial.providers?.[providerName];
    const baseURL = provider?.baseURL ?? initial.providers?.["local-ollama"]?.baseURL;
    if (!nonEmptyString(baseURL)) throw new Error(`provider ${providerName} has no baseURL`);
    if (!catalogs.has(baseURL)) catalogs.set(baseURL, await fetchRouterCatalog(baseURL));
    const modelIds = provider?.models?.map(model => model.id) ?? ["qwen3.8-27b-abliterated-q6_k"];
    for (const modelId of modelIds) {
      let entry;
      try { entry = resolveRouterEntry(catalogs.get(baseURL), modelId); }
      catch (error) {
        if (!provider && error.code === "ROUTER_MODEL_NOT_FOUND") continue;
        throw error;
      }
      const metadata = routerMetadataOf(entry);
      requireRouterCapabilities(metadata, { effort: (provider ?? initial.providers?.["local-ollama"])?.reasoning });
      plans.push({ providerName, modelId, metadata });
    }
  }
  for (const { providerName, modelId, metadata } of plans) {
    let settings = settingsService.get("llm-pi-ai");
    let stored = settingsService.describe().find(entry => entry.ns === "llm-pi-ai")?.user;
    const provision = provisionProviderOps(settings, providerName, modelId, stored);
    if (provision.length) {
      // Provision with the target's capabilities in the same atomic operation.
      const proposed = { providers: { [providerName]: provision[0].value } };
      for (const op of capabilityOps(proposed, providerName, modelId, metadata)) applyOperation(proposed, op);
      provision[0].value = proposed.providers[providerName];
      await settingsService.mutate("llm-pi-ai", provision);
      settings = settingsService.get("llm-pi-ai");
      stored = settingsService.describe().find(entry => entry.ns === "llm-pi-ai")?.user;
    }
    const ops = capabilityOps(settings, providerName, modelId, metadata, stored);
    if (ops.length) await settingsService.mutate("llm-pi-ai", ops);
  }
  const primary = plans.find(plan => plan.providerName === "local-ollama");
  if (primary) {
    const settings = settingsService.get("llm-pi-ai");
    const retired = settings.providers?.["local-ollama-256k"];
    const ownedRetired = retired?.baseURL === settings.providers?.["local-ollama"]?.baseURL &&
      retired?.models?.length === 1 && retired.models[0].id === "local-active";
    const selected = settingsService.get("agent-default-model");
    if (ownedRetired && selected?.provider === "local-ollama-256k") {
      await settingsService.mutate("agent-default-model", [
        { op: "set", path: ["provider"], value: "local-ollama" },
        { op: "set", path: ["model"], value: primary.modelId }
      ]);
    }
    if (ownedRetired) await settingsService.mutate("llm-pi-ai", [{ op: "unset", path: ["providers", "local-ollama-256k"] }]);
  }
}

export function applyOperation(settings, operation) {
  const parent = operation.path.slice(0, -1).reduce((object, key) => object[key] ??= {}, settings);
  if (operation.op === "unset") delete parent[operation.path.at(-1)];
  else parent[operation.path.at(-1)] = structuredClone(operation.value);
}

/** Cordis plugin entry point. */
export function apply(ctx, config = {}) {
  const configuredProviders = Array.isArray(config.providers) ? config.providers.filter(nonEmptyString) : [];
  const providers = configuredProviders.length > 0 ? configuredProviders.filter((p) => p !== "local-ollama-256k") : DEFAULT_PROVIDERS;

  const configuredInterval = Number(config.pollIntervalMs);
  const pollIntervalMs = Number.isFinite(configuredInterval)
    ? Math.max(MIN_POLL_INTERVAL_MS, Math.trunc(configuredInterval))
    : DEFAULT_POLL_INTERVAL_MS;
  // Follow DSH's canonical optional-settings pattern. The plugin itself loads
  // regardless of service ordering; this scoped callback activates whenever
  // the settings provider is available and owns all timer cleanup.
  ctx.inject(["settings"], (sctx) => {
    const settingsService = sctx.settings;
    let stopped = false;
    let timer;
    let running = false;
    const lastFailure = new Map();

    const reportFailure = (provider, error) => {
      const message = String(error?.message ?? error);
      if (lastFailure.get(provider) === message) return;
      lastFailure.set(provider, message);
      sctx.logger.warn(`router-model-discovery: ${provider}: ${message}`);
    };

    const synchronize = async () => {
      if (running || stopped) return;
      running = true;
      try {
        await synchronizeRouterSettings(settingsService, providers);
        lastFailure.clear();
      } catch (error) {
        reportFailure("llm-pi-ai", error);
      } finally {
        running = false;
      }
    };

    void synchronize();
    timer = setInterval(() => void synchronize(), pollIntervalMs);
    sctx.effect(
      () => () => {
        stopped = true;
        clearInterval(timer);
      },
      "router model discovery synchronization",
    );
  });
}
