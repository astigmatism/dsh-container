/**
 * Keep DSH's local-active model capabilities aligned with the router marker.
 *
 * The router owns per-effort output limits. This plugin deliberately does not
 * mutate DSH's maxTokens (or its intentionally distinct context-window
 * profiles); it only consumes facts that can be represented losslessly by
 * dsh-llm-pi-ai today: input modalities and reasoning effort wire values.
 */

export const name = "router-model-discovery";

const DSH_REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const DSH_INPUT_MODALITIES = new Set(["text", "image"]);
const DEFAULT_PROVIDERS = ["local-ollama", "local-ollama-256k"];
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
  if (!positiveInteger(metadata.context_window)) {
    throw new Error("router discovery metadata has no valid context_window");
  }
  if (!Array.isArray(metadata.input_modalities) || metadata.input_modalities.some((value) => !nonEmptyString(value))) {
    throw new Error("router discovery metadata has invalid input_modalities");
  }
  const reasoning = metadata.reasoning;
  if (!plainObject(reasoning) || typeof reasoning.supported !== "boolean") {
    throw new Error("router discovery metadata has no definitive reasoning capability");
  }
  if (!plainObject(reasoning.efforts) || !plainObject(reasoning.aliases) || !plainObject(reasoning.per_effort)) {
    throw new Error("router discovery metadata has incomplete reasoning maps");
  }
  if (!positiveInteger(reasoning.absolute_max_output_tokens)) {
    throw new Error("router discovery metadata has no valid absolute reasoning output limit");
  }
  for (const [level, wire] of Object.entries(reasoning.efforts)) {
    if (!nonEmptyString(level) || !nonEmptyString(wire) || !plainObject(reasoning.per_effort[level])) {
      throw new Error(`router discovery metadata has an invalid reasoning effort "${level}"`);
    }
    const limits = reasoning.per_effort[level];
    if (
      typeof limits.enabled !== "boolean" ||
      !positiveInteger(limits.default_output_tokens) ||
      !positiveInteger(limits.max_output_tokens) ||
      limits.default_output_tokens > limits.max_output_tokens
    ) {
      throw new Error(`router discovery metadata has invalid limits for reasoning effort "${level}"`);
    }
  }
  for (const [alias, target] of Object.entries(reasoning.aliases)) {
    if (!nonEmptyString(alias) || !nonEmptyString(target) || reasoning.efforts[target] === undefined) {
      throw new Error(`router discovery metadata has an invalid reasoning alias "${alias}"`);
    }
  }
  return metadata;
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
      // Send the documented alias itself. The router canonicalizes it to target.
      mapped[level] = level;
    }
  }
  if (!Object.keys(mapped).some((level) => level !== "off")) {
    throw new Error("router reasoning metadata exposes no DSH-selectable enabled effort");
  }
  return mapped;
}

/** Return only lossless capability mutations; never output/context capacities. */
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
  if (sameJson(model.input, input) && sameJson(model.reasoningEfforts, reasoningEfforts)) return [];

  // SettingsPathOp descends through plain objects, not arrays. Replace the
  // stored provider models array atomically. Prefer the raw user-layer rows so
  // schema defaults from the resolved view are not materialized incidentally.
  const storedModels = storedSettings?.providers?.[providerName]?.models;
  const sourceModels = Array.isArray(storedModels) && storedModels.some((candidate) => candidate?.id === modelId)
    ? storedModels
    : models;
  const sourceIndex = sourceModels.findIndex((candidate) => candidate?.id === modelId);
  const nextModels = sourceModels.map((candidate, index) =>
    index === sourceIndex ? { ...candidate, input, reasoningEfforts } : candidate,
  );
  return [{
    op: "set",
    path: ["providers", providerName, "models"],
    value: nextModels,
  }];
}

function listingUrl(baseURL) {
  return `${baseURL.replace(/\/+$/, "")}/models`;
}

async function fetchEntry(baseURL, modelId, signal) {
  const url = listingUrl(baseURL);
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.data)) throw new Error(`${url} returned no model data array`);
  const entry = body.data.find((candidate) => candidate?.id === modelId);
  if (entry === undefined) throw new Error(`${url} did not advertise model "${modelId}"`);
  return entry;
}

/** Cordis plugin entry point. */
export function apply(ctx, config = {}) {
  const configuredProviders = Array.isArray(config.providers) ? config.providers.filter(nonEmptyString) : [];
  const providers = configuredProviders.length > 0 ? configuredProviders : DEFAULT_PROVIDERS;
  const modelId = nonEmptyString(config.model) ? config.model : "local-active";
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
        const settings = settingsService.get("llm-pi-ai");
        if (!plainObject(settings)) throw new Error('DSH settings namespace "llm-pi-ai" is not registered yet');
        const byEndpoint = new Map();
        for (const providerName of providers) {
          try {
            const baseURL = settings.providers?.[providerName]?.baseURL;
            if (!nonEmptyString(baseURL)) throw new Error("provider has no baseURL");
            const cacheKey = `${baseURL}\n${modelId}`;
            let pending = byEndpoint.get(cacheKey);
            if (pending === undefined) {
              pending = fetchEntry(baseURL, modelId, AbortSignal.timeout(10_000));
              byEndpoint.set(cacheKey, pending);
            }
            const metadata = routerMetadataOf(await pending);
            const latest = settingsService.get("llm-pi-ai");
            const descriptor = settingsService.describe().find((candidate) => candidate.ns === "llm-pi-ai");
            const ops = capabilityOps(latest, providerName, modelId, metadata, descriptor?.user);
            if (ops.length > 0) {
              await settingsService.mutate("llm-pi-ai", ops);
              sctx.logger.info(`router-model-discovery: synchronized ${providerName}/${modelId} capabilities`);
            }
            lastFailure.delete(providerName);
          } catch (error) {
            reportFailure(providerName, error);
          }
        }
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
