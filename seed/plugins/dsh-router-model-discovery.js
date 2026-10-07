/** Resident model discovery under the LLM Router client contract, version 1.
 *
 * docs/llm-router-contract.md is authoritative. Harness sends only the stable
 * service IDs `daytime` and `nighttime`, reads `/v1/router/capabilities` at
 * startup, follows `/v1/router/events` for its lifetime and polls while the
 * stream is down. Each service is evaluated on its own; one model's state never
 * blocks updates to the other. Fallback is deliberately disabled (§5): an
 * unusable model stays visible, is labelled with exactly one state and fails
 * fast at dispatch, while a draining router makes requests wait.
 */
import { hostname } from "node:os";

export const name = "router-model-discovery";

/** Provider routes Harness owns, and the stable router service each one sends. */
export const RESIDENT_SERVICES = Object.freeze({ "local-ollama": "daytime", "local-everyday": "nighttime" });
const DEFAULT_PROVIDERS = Object.keys(RESIDENT_SERVICES);
const SERVICE_LABELS = Object.freeze({ daytime: "Daytime", nighttime: "Nighttime" });
/** Exactly one of these is shown for each resident model. */
export const RESIDENT_STATUSES = Object.freeze(["available", "offline", "unavailable", "switching", "incomplete"]);
/** States in which dispatch fails at once. A switching router makes requests wait instead. */
const BLOCKING_STATUSES = new Set(["offline", "unavailable", "incomplete"]);
const STATUS_TEXT = Object.freeze({
  available: "available",
  offline: "offline",
  unavailable: "unavailable",
  switching: "router switching configuration",
  incomplete: "incomplete metadata",
});
const CAPABILITIES_SCHEMA_VERSION = 1;
const METADATA_SCHEMA_VERSION = 2;
const DSH_REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const DSH_INPUT_MODALITIES = new Set(["text", "image"]);
const CLIENT_NAME_HEADER = "X-Client-Name";
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MIN_POLL_INTERVAL_MS = 5_000;
const STREAM_RETRY_MS = 3_000;
const STREAM_MAX_RETRY_MS = 30_000;
const STREAM_DEAD_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;
/** A request-time contradiction of the document holds this long unless a new revision arrives. */
const REQUEST_HOLD_MS = 60_000;
/** BACKEND_UNAVAILABLE failures, after the provider's bounded retries, that mark a model unavailable. */
const BACKEND_FAILURE_THRESHOLD = 3;
const BACKEND_FAILURE_WINDOW_MS = 5 * 60_000;
/** Process-wide channel used by the patched pi-ai adapter to report router error codes. */
export const ROUTER_CONTRACT_HUB = Symbol.for("dsh-container.router-contract.v1");
/** A watcher that has not finished its first read: leave that model's state as it is. */
export const DOCUMENT_PENDING = Symbol("router document pending");

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
}
/** Settings forms return fields in schema order; compare content, not key order. */
function sameJson(left, right) {
  return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
}
function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
function errorText(error) {
  return String(error?.message ?? error);
}

/**
 * A per-request signal that follows `parent` and a timeout, with listeners
 * removed afterwards. A watcher lives for the whole process, so per-request
 * listeners on its lifetime signal must not accumulate.
 */
function linkedSignal(parent, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new DOMException("router request timed out", "TimeoutError")), timeoutMs);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onAbort, { once: true });
  return { signal: controller.signal, abort: reason => controller.abort(reason), dispose() { clearTimeout(timer); parent?.removeEventListener("abort", onAbort); } };
}

/** The value sent as `X-Client-Name` on every provider request and discovery fetch. */
export function routerClientName({ instance, env = globalThis.process?.env ?? {} } = {}) {
  let raw = nonEmptyString(instance) ? instance : env.HARNESS_CLIENT_INSTANCE;
  if (!nonEmptyString(raw?.trim?.())) {
    try { raw = hostname(); } catch { raw = "unknown"; }
  }
  const clean = String(raw).trim().replace(/[^A-Za-z0-9._:@-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return `deepseek-harness/${clean || "unknown"}`;
}

/** Router root (without `/v1`) for a provider's OpenAI-compatible base URL. */
export function routerBaseOf(baseURL) {
  let endpoint;
  try { endpoint = new URL(baseURL); } catch { throw new Error("router provider baseURL is invalid"); }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error("router provider baseURL must use HTTP(S) without embedded credentials");
  }
  return String(baseURL).replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** Read the deployment document once, revalidating with `If-None-Match`. */
export async function fetchCapabilities(baseURL, { etag, clientName = routerClientName(), signal, timeoutMs = FETCH_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  const base = routerBaseOf(baseURL);
  const headers = { accept: "application/json", [CLIENT_NAME_HEADER]: clientName };
  if (nonEmptyString(etag)) headers["if-none-match"] = etag;
  const linked = linkedSignal(signal, timeoutMs);
  try {
    const response = await fetchImpl(`${base}/v1/router/capabilities`, { headers, signal: linked.signal });
    if (response.status === 304) return { status: 304, etag };
    if (response.status === 404) {
      // A pre-contract router (the vendored managed-mode router) has no
      // capabilities endpoint. Describe what its model listing offers instead.
      await response.body?.cancel?.().catch?.(() => {});
      const legacy = await fetchImpl(`${base}/v1/models`, { headers: { accept: "application/json", [CLIENT_NAME_HEADER]: clientName },
        signal: linked.signal });
      if (!legacy.ok) {
        const error = new Error(`router capabilities returned HTTP 404 and its model listing HTTP ${legacy.status}`);
        error.code = "ROUTER_CAPABILITIES_HTTP";
        throw error;
      }
      return { status: 200, document: legacyCapabilities(await legacy.json()) };
    }
    if (!response.ok) {
      await response.body?.cancel?.().catch?.(() => {});
      const error = new Error(`router capabilities returned HTTP ${response.status}`);
      error.code = "ROUTER_CAPABILITIES_HTTP";
      throw error;
    }
    return { status: 200, etag: response.headers.get("etag") ?? undefined, document: await response.json() };
  } finally {
    linked.dispose();
  }
}

/**
 * Synthesize a capabilities document from a pre-contract `/v1/models` listing.
 * `local-active` is the legacy alias of `daytime` (§3). The result is marked
 * `legacy`: such a router publishes no admission state or offline services.
 */
export function legacyCapabilities(body) {
  const rows = Array.isArray(body?.data) ? body.data.filter(row => plainObject(row) && nonEmptyString(row.id)) : [];
  const canonical = new Set(rows.filter(row => row.x_ollama_router?.alias !== true).map(row => row.id));
  const models = [];
  for (const row of rows) {
    const metadata = plainObject(row.x_ollama_router) ? row.x_ollama_router : {};
    if (metadata.alias === true && canonical.has(metadata.upstream_model)) continue;
    const aliases = [...new Set([...(Array.isArray(metadata.aliases) ? metadata.aliases.filter(nonEmptyString) : []), ...(metadata.alias === true ? [row.id] : [])])];
    const service = [row.id, ...aliases].includes("daytime") || [row.id, ...aliases].includes("local-active") ? "daytime"
      : [row.id, ...aliases].includes("nighttime") ? "nighttime" : undefined;
    if (!service) continue;
    models.push({
      id: nonEmptyString(metadata.upstream_model) ? metadata.upstream_model : row.id, service, aliases: [...new Set([...aliases, service])],
      display_name: metadata.display_name, available: metadata.health?.available !== false,
      slots: metadata.active_request_limit, context_window: metadata.context_window,
      input_modalities: metadata.input_modalities, capabilities: metadata.capabilities, nsfw: metadata.nsfw ?? null, metadata,
    });
  }
  const document = { object: "router.capabilities", schema_version: CAPABILITIES_SCHEMA_VERSION, legacy: true,
    router: { accepting_requests: true }, configuration: null, models, offline_services: [] };
  document.revision = `legacy:${JSON.stringify(ordered(models))}`;
  return document;
}

/**
 * Validate the public router metadata (`models[].metadata`, identical to
 * `x_ollama_router`) before any of it reaches Harness settings. Unknown fields
 * are allowed so schema v2 can grow compatibly. Health is not judged here: the
 * capabilities document's `available` is authoritative for availability.
 */
export function validateRouterMetadata(metadata) {
  if (!plainObject(metadata) || metadata.schema_version !== METADATA_SCHEMA_VERSION) {
    throw new Error(`router metadata is not schema v${METADATA_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(metadata.warnings)) throw new Error("router metadata has no warnings list");
  if (metadata.warnings.length) throw new Error(`router metadata has warnings: ${metadata.warnings.filter(nonEmptyString).join(", ") || "unspecified"}`);
  if (metadata.complete !== true) throw new Error("router metadata is incomplete");
  for (const field of ["context_window", "active_request_limit"]) {
    if (!positiveInteger(metadata[field])) throw new Error(`router metadata has no valid ${field}`);
  }
  const reserve = metadata.context_safety_reserve;
  if (reserve !== undefined && reserve !== null && (!Number.isSafeInteger(reserve) || reserve < 0 || reserve >= metadata.context_window)) {
    throw new Error("router metadata has an invalid context_safety_reserve");
  }
  for (const field of ["input_modalities", "capabilities"]) {
    if (!Array.isArray(metadata[field]) || !metadata[field].length || metadata[field].some(value => !nonEmptyString(value))) {
      throw new Error(`router metadata has invalid ${field}`);
    }
  }
  if (!metadata.input_modalities.includes("text") || metadata.input_modalities.includes("image") !== metadata.capabilities.includes("vision")) {
    throw new Error("router metadata has inconsistent input capabilities");
  }
  const unrestricted = metadata.output_policy === "unrestricted";
  if (!unrestricted && ![undefined, "legacy", "bounded"].includes(metadata.output_policy)) {
    throw new Error("router metadata has an unknown output_policy");
  }
  if (unrestricted
    ? metadata.max_output_tokens !== null || metadata.default_output_tokens !== null
    : !positiveInteger(metadata.max_output_tokens) || (metadata.default_output_tokens !== undefined &&
      (!positiveInteger(metadata.default_output_tokens) || metadata.default_output_tokens > metadata.max_output_tokens))) {
    throw new Error("router metadata has invalid output limits");
  }
  const reasoning = metadata.reasoning;
  if (!plainObject(reasoning) || typeof reasoning.supported !== "boolean") throw new Error("router metadata has no definitive reasoning capability");
  if (reasoning.supported !== metadata.capabilities.includes("thinking")) throw new Error("router metadata has inconsistent reasoning capability");
  if (!plainObject(reasoning.efforts) || !plainObject(reasoning.aliases) || !plainObject(reasoning.per_effort)) {
    throw new Error("router metadata has incomplete reasoning maps");
  }
  if (!["cap", "reject"].includes(reasoning.output_limit_policy)) throw new Error("router metadata has an invalid output_limit_policy");
  if (unrestricted ? reasoning.absolute_max_output_tokens !== null : !positiveInteger(reasoning.absolute_max_output_tokens)) {
    throw new Error("router metadata has no valid absolute reasoning output limit");
  }
  if (reasoning.absolute_max_output_tokens !== metadata.max_output_tokens) throw new Error("router metadata has inconsistent output limits");
  for (const [level, wire] of Object.entries(reasoning.efforts)) {
    if (!nonEmptyString(level) || !nonEmptyString(wire) || !plainObject(reasoning.per_effort[level])) {
      throw new Error(`router metadata has an invalid reasoning effort "${level}"`);
    }
    const limits = reasoning.per_effort[level];
    if (typeof limits.enabled !== "boolean" || (unrestricted
      ? limits.default_output_tokens !== null || limits.max_output_tokens !== null
      : !positiveInteger(limits.default_output_tokens) || !positiveInteger(limits.max_output_tokens) ||
        limits.default_output_tokens > limits.max_output_tokens || limits.max_output_tokens > reasoning.absolute_max_output_tokens)) {
      throw new Error(`router metadata has invalid limits for reasoning effort "${level}"`);
    }
  }
  for (const [alias, target] of Object.entries(reasoning.aliases)) {
    if (!nonEmptyString(alias) || !nonEmptyString(target) || !Object.hasOwn(reasoning.efforts, target)) {
      throw new Error(`router metadata has an invalid reasoning alias "${alias}"`);
    }
  }
  if (reasoning.supported === true) {
    const target = reasoning.aliases[reasoning.default] ?? reasoning.default;
    if (!nonEmptyString(reasoning.default) || !Object.hasOwn(reasoning.efforts, target)) {
      throw new Error("router metadata reasoning default is not supported");
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

/** Feature checks (§5): vision/tools for browser routes and the configured effort. */
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

/** Problems that make a whole capabilities document unusable. */
export function documentProblem(document) {
  if (!plainObject(document)) return "router capabilities document is not an object";
  if (!Array.isArray(document.models)) return "router capabilities document has no models list";
  if (!plainObject(document.router) || typeof document.router.accepting_requests !== "boolean") {
    return "router capabilities document has no admission state";
  }
  if (document.offline_services !== undefined && !Array.isArray(document.offline_services)) {
    return "router capabilities document has invalid offline_services";
  }
  return undefined;
}

function serviceMatches(row, service) {
  return plainObject(row) && (row.service === service || row.id === service ||
    (Array.isArray(row.aliases) && row.aliases.includes(service)));
}

/**
 * Evaluate one service from the current document, independently of every other
 * service. `document === null` means the router is unreachable. The result
 * carries the canonical model only as information; it is never persisted.
 */
export function residentStatus(document, service) {
  const unavailable = (reason) => ({ service, status: "unavailable", reason, configuration: null, nsfw: null });
  if (document === null || document === undefined) return unavailable("router unreachable");
  const problem = documentProblem(document);
  if (problem) return { service, status: "incomplete", reason: problem, configuration: null, nsfw: null };
  const configuration = nonEmptyString(document.configuration?.id) ? document.configuration.id : null;
  const base = { service, configuration, nsfw: null };
  const matches = document.models.filter(row => serviceMatches(row, service));
  const model = matches.length === 1 ? matches[0] : undefined;
  const served = nonEmptyString(model?.id) ? model.id : null;
  // A draining or maintained router accepts nothing. Wait, never switch (§5, §7).
  if (document.router.accepting_requests !== true) {
    const reason = document.router.maintenance === true ? "maintenance" : "draining";
    return { ...base, status: "switching", reason, served, nsfw: model?.nsfw ?? null };
  }
  if (matches.length > 1) return { ...base, status: "incomplete", reason: `ambiguous router service "${service}"` };
  if (!model) {
    const offline = (document.offline_services ?? []).find(row => plainObject(row) &&
      (row.model === service || (Array.isArray(row.aliases) && row.aliases.includes(service))));
    if (offline) {
      return { ...base, status: "offline", reason: nonEmptyString(offline.reason) ? offline.reason : "offline_service" };
    }
    // A disappeared ID with no offline entry is a configuration change.
    return { ...base, status: "unavailable", reason: "not offered by the router" };
  }
  const nsfw = model.nsfw === true ? true : model.nsfw === false ? false : null;
  if (model.available !== true) {
    return { ...base, status: "unavailable", reason: "backend unavailable", served, nsfw };
  }
  let metadata;
  let capabilities;
  try {
    if (!positiveInteger(model.slots)) throw new Error("router model has no valid slots");
    if (!positiveInteger(model.context_window)) throw new Error("router model has no valid context_window");
    metadata = validateRouterMetadata(model.metadata);
    if (metadata.context_window !== model.context_window) throw new Error("router model context_window disagrees with its metadata");
    if (metadata.active_request_limit !== model.slots) throw new Error("router model slots disagree with its metadata");
    capabilities = residentCapabilities({ model, metadata });
  } catch (error) {
    // A pre-contract router publishes no complete metadata; its route stays
    // usable with the stored limits, as before discovery existed.
    if (document.legacy === true) return { ...base, status: "available", reason: "legacy router without published limits", served, nsfw, legacy: true };
    return { ...base, status: "incomplete", reason: errorText(error), served, nsfw };
  }
  return { ...base, status: "available", reason: null, served, nsfw, model, metadata, capabilities };
}

/** Limits and features of the model that will actually serve the service. */
export function residentCapabilities({ model, metadata }) {
  const input = metadata.input_modalities.filter(value => DSH_INPUT_MODALITIES.has(value));
  if (!input.includes("text")) throw new Error("router advertises no input modality Harness can represent");
  const reserve = metadata.context_safety_reserve ?? 0;
  const displayName = nonEmptyString(metadata.display_name) ? metadata.display_name
    : nonEmptyString(model.display_name) ? model.display_name : undefined;
  return {
    displayName,
    // Admission requires input + output + reserve <= context_window (§8), so
    // the Harness budget and compaction thresholds use the remainder.
    contextWindow: model.context_window - reserve,
    contextSafetyReserve: reserve,
    maxConcurrency: model.slots,
    maxTokens: metadata.max_output_tokens,
    input,
    reasoningEfforts: dshReasoningEfforts(metadata.reasoning),
  };
}

/** The single picker label for a resident in its current state. */
export function residentLabel(state, capabilities = state?.capabilities) {
  const label = SERVICE_LABELS[state?.service] ?? state?.service ?? "Model";
  if (state?.status === "available") {
    const name = capabilities?.displayName ?? label;
    return state.nsfw === true ? `${name} · NSFW` : name;
  }
  if (state?.status === "offline") return state.configuration ? `${label} — offline (${state.configuration})` : `${label} — offline`;
  return `${label} — ${STATUS_TEXT[state?.status] ?? STATUS_TEXT.unavailable}`;
}

/** The dispatch failure shown when a blocked resident is asked to serve. */
export function residentMessage(state) {
  const label = SERVICE_LABELS[state.service] ?? state.service;
  const advice = state.service === "nighttime"
    ? "Switch this session to Daytime; Nighttime becomes selectable again automatically when it returns."
    : `Select another model, or retry when ${label} returns; Harness reconnects automatically.`;
  switch (state.status) {
    case "offline":
      return `${label} is offline in router configuration ${state.configuration ? `"${state.configuration}"` : "(unknown)"}${state.reason ? ` (${state.reason})` : ""}. ${advice}`;
    case "incomplete":
      return `${label} is unavailable: the router published incomplete metadata for it (${state.reason}). ${advice}`;
    case "switching":
      return `The router is switching configuration (${state.reason}); requests to ${label} wait and retry without changing models.`;
    case "unavailable":
      return state.reason === "router unreachable"
        ? `${label} is unavailable: the router is unreachable. ${advice}`
        : `${label} is unavailable: ${state.reason}. ${advice}`;
    default:
      return `${label} is available.`;
  }
}

/** Persisted, canonical-ID-free summary that the adapter and picker read. */
export function residentStateRecord(state, storedName) {
  const published = state.status === "available" && state.capabilities !== undefined;
  return {
    service: state.service,
    status: state.status,
    label: state.status === "available" && !published && nonEmptyString(storedName) ? storedName : residentLabel(state),
    ...(state.status === "available" ? {} : { message: residentMessage(state) }),
    configuration: state.configuration ?? null,
    reason: state.reason ?? null,
    limits: published ? "current" : state.status === "available" ? "stored" : "stale",
    nsfw: state.nsfw ?? null,
  };
}

export function isBlockingStatus(status) {
  return BLOCKING_STATUSES.has(status);
}

/** Text for transition logs, e.g. `offline (flash-next-solo-128k)`. */
export function describeStatus(state) {
  const text = STATUS_TEXT[state?.status] ?? String(state?.status ?? "unknown");
  const detail = state?.status === "offline" ? state.configuration : state?.reason;
  return detail ? `${text} (${detail})` : text;
}

/** Route old persisted IDs of Harness-owned providers to their service IDs. */
export function migrateResidentRoute(config, providers = DEFAULT_PROVIDERS) {
  if (!plainObject(config) || !providers.includes(config.provider)) return config;
  const service = RESIDENT_SERVICES[config.provider];
  if (!nonEmptyString(service) || !nonEmptyString(config.model) || config.model === service) return config;
  return { ...config, model: service };
}

function withClientName(headers, clientName) {
  const next = Object.fromEntries(Object.entries(plainObject(headers) ? headers : {})
    .filter(([header]) => header.toLowerCase() !== CLIENT_NAME_HEADER.toLowerCase()));
  next[CLIENT_NAME_HEADER] = clientName;
  return next;
}

/**
 * Converge one Harness-owned provider on its service ID, client identity and
 * current state. Explicit preferences, credentials references and unrelated
 * fields survive. Limits change only while the model is available; otherwise
 * the last limits are kept and marked stale.
 */
export function planResidentProvider({ name: provider, state, stored, resolved, daytime, clientName }) {
  const service = RESIDENT_SERVICES[provider];
  let source = plainObject(stored) ? stored : plainObject(resolved) ? resolved : undefined;
  if (!source) {
    // Provision a missing Nighttime route from the working Daytime route,
    // without inheriting Daytime's limits.
    if (!plainObject(daytime)) throw new Error(`cannot provision "${provider}" without local-ollama`);
    source = Object.fromEntries(["apiKeyEnv", "headers", "streamIdleTimeoutMs", "cacheRetention", "retryPolicy", "reasoning", "baseURL"]
      .filter(key => daytime[key] !== undefined).map(key => [key, clone(daytime[key])]));
    source.displayName = SERVICE_LABELS[service];
    source.models = [{ id: service, name: SERVICE_LABELS[service] }];
  }
  const rows = Array.isArray(source.models) ? source.models : [];
  const row = rows.find(candidate => candidate?.id === service) ?? rows[0] ?? { name: SERVICE_LABELS[service] };
  const next = {
    ...clone(source),
    api: "openai-responses",
    baseURL: source.baseURL ?? resolved?.baseURL ?? daytime?.baseURL,
    headers: withClientName(source.headers, clientName),
    models: [{ ...clone(row), id: service }],
  };
  if (state.status === "available" && state.capabilities) {
    const capabilities = state.capabilities;
    const label = residentLabel(state, capabilities);
    if (capabilities.displayName) next.displayName = capabilities.displayName;
    next.maxConcurrency = capabilities.maxConcurrency;
    // Keep explicit client policy separate from the router's raw default.
    if (next.reasoning === undefined && capabilities.reasoningEfforts?.medium) next.reasoning = "medium";
    Object.assign(next.models[0], {
      name: label,
      contextWindow: capabilities.contextWindow,
      maxTokens: capabilities.maxTokens,
      input: capabilities.input,
      reasoningEfforts: capabilities.reasoningEfforts,
    });
  } else if (!nonEmptyString(next.models[0].name)) {
    next.models[0].name = SERVICE_LABELS[service];
  }
  next.residentUnavailable = BLOCKING_STATUSES.has(state.status);
  next.residentState = residentStateRecord(state, next.models[0].name);
  return next;
}

function readNamespace(service, namespace) {
  // 0.1.7 exposes live entry Config through descriptors rather than get().
  return typeof service.get === "function" ? service.get(namespace)
    : service.describe().find(entry => entry.ns === namespace)?.value;
}
function storedNamespace(service, namespace) {
  return service.describe().find(entry => entry.ns === namespace)?.user;
}

export function applyOperation(settings, operation) {
  const parent = operation.path.slice(0, -1).reduce((object, key) => object[key] ??= {}, settings);
  if (operation.op === "unset") delete parent[operation.path.at(-1)];
  else parent[operation.path.at(-1)] = structuredClone(operation.value);
}

function effectiveState(state, hold, revision, now) {
  if (!hold || state.status !== "available") return state;
  if (hold.until <= now || (hold.revision !== undefined && hold.revision !== revision)) return state;
  return { ...state, status: hold.status, reason: hold.reason, configuration: hold.configuration ?? state.configuration,
    capabilities: undefined, metadata: undefined };
}

/**
 * Bring the Harness-owned providers in line with the router, one provider at a
 * time. `document` maps a provider base URL to its current document, `null`
 * when unreachable, or `undefined` to fetch it now (startup migration and
 * verification). Only invalid local settings throw.
 */
export async function synchronizeRouterSettings(settingsService, {
  providers = DEFAULT_PROVIDERS, document, clientName = routerClientName(), holds = new Map(),
  now = Date.now(), fetchOptions = {}, onFetchError,
} = {}) {
  const initial = readNamespace(settingsService, "llm-pi-ai");
  if (!plainObject(initial)) throw new Error('Harness settings namespace "llm-pi-ai" is not registered yet');
  const daytimeResolved = initial.providers?.["local-ollama"];
  if (!plainObject(daytimeResolved)) throw new Error("Missing local-ollama provider");
  const managed = providers.filter(provider => Object.hasOwn(RESIDENT_SERVICES, provider));
  const fetched = new Map();
  const documentFor = async (baseURL) => {
    if (typeof document === "function") return document(baseURL);
    if (document !== undefined) return document;
    if (!fetched.has(baseURL)) {
      fetched.set(baseURL, fetchCapabilities(baseURL, { clientName, ...fetchOptions })
        .then(result => result.document ?? null)
        .catch(error => { onFetchError?.(baseURL, error); return null; }));
    }
    return fetched.get(baseURL);
  };
  const results = new Map();
  const errors = [];
  for (const provider of managed) {
    try {
      const before = readNamespace(settingsService, "llm-pi-ai");
      const stored = storedNamespace(settingsService, "llm-pi-ai") ?? before;
      const resolved = before.providers?.[provider];
      const daytime = stored.providers?.["local-ollama"] ?? before.providers?.["local-ollama"];
      const baseURL = resolved?.baseURL ?? stored.providers?.[provider]?.baseURL ?? daytime?.baseURL;
      if (!nonEmptyString(baseURL)) throw new Error(`provider ${provider} has no baseURL`);
      routerBaseOf(baseURL);
      const current = await documentFor(baseURL);
      if (current === DOCUMENT_PENDING) continue;
      const state = effectiveState(residentStatus(current, RESIDENT_SERVICES[provider]), holds.get(provider),
        current?.revision, now);
      const next = planResidentProvider({ name: provider, state, stored: stored.providers?.[provider], resolved, daytime, clientName });
      const latest = readNamespace(settingsService, "llm-pi-ai");
      if (!sameJson(latest.providers?.[provider], resolved)) {
        throw new Error("resident settings changed during discovery; retrying on the next refresh");
      }
      results.set(provider, { state, next, recorded: plainObject(resolved?.residentState) ? resolved.residentState : undefined });
      const previous = storedNamespace(settingsService, "llm-pi-ai")?.providers?.[provider];
      if (!sameJson(previous, next)) {
        await settingsService.mutate("llm-pi-ai", [{ op: "set", path: ["providers", provider], value: next }]);
        results.get(provider).changed = true;
      }
    } catch (error) {
      errors.push({ provider, error });
    }
  }
  try {
    await migrateDefaultSelection(settingsService, managed);
  } catch (error) {
    errors.push({ provider: "agent-default-model", error });
  }
  return { results, errors };
}

/** Retire the old 256K Daytime route and move saved defaults to service IDs. */
async function migrateDefaultSelection(settingsService, managed) {
  const settings = readNamespace(settingsService, "llm-pi-ai");
  const retired = settings.providers?.["local-ollama-256k"];
  const ownedRetired = plainObject(retired) && retired.baseURL === settings.providers?.["local-ollama"]?.baseURL &&
    retired.models?.length === 1 && ["local-active", "daytime"].includes(retired.models[0]?.id);
  const selected = readNamespace(settingsService, "agent-default-model");
  let nextSelection;
  if (ownedRetired && selected?.provider === "local-ollama-256k") {
    nextSelection = { ...selected, provider: "local-ollama", model: RESIDENT_SERVICES["local-ollama"] };
  } else if (plainObject(selected)) {
    const migrated = migrateResidentRoute(selected, managed);
    if (migrated !== selected) nextSelection = migrated;
  }
  if (ownedRetired) await settingsService.mutate("llm-pi-ai", [{ op: "unset", path: ["providers", "local-ollama-256k"] }]);
  if (nextSelection) {
    const ops = Object.entries(nextSelection).filter(([key, value]) => !sameJson(selected[key], value))
      .map(([key, value]) => ({ op: "set", path: [key], value }));
    if (ops.length) await settingsService.mutate("agent-default-model", ops);
  }
}

/**
 * Follow one router: read the document, subscribe to `/v1/router/events`,
 * replace the copy whenever `revision` changes, and poll with `If-None-Match`
 * while disconnected. Adapted from the reference client `watchRouter`
 * (llm-router docs/clients/router-watch.mjs at d5edba8).
 */
export class RouterWatch {
  constructor(baseURL, {
    clientName = routerClientName(), onDocument = () => {}, onReachability = () => {}, logger,
    pollMs = DEFAULT_POLL_INTERVAL_MS, retryMs = STREAM_RETRY_MS, maxRetryMs = STREAM_MAX_RETRY_MS,
    deadMs = STREAM_DEAD_MS, fetchTimeoutMs = FETCH_TIMEOUT_MS, fetchImpl = globalThis.fetch,
  } = {}) {
    this.base = routerBaseOf(baseURL);
    Object.assign(this, { clientName, onDocument, onReachability, logger, pollMs, retryMs, maxRetryMs, deadMs, fetchTimeoutMs, fetchImpl });
    this.current = undefined;
    this.etag = undefined;
    this.reachable = undefined;
    this.connected = false;
    this.stopped = false;
    this.lifetime = new AbortController();
  }

  start() {
    this.ready = this.refresh().catch(() => undefined);
    this.following = this.follow();
    return this;
  }

  stop() {
    this.stopped = true;
    this.lifetime.abort(new Error("router watch stopped"));
  }

  accept(document) {
    if (this.current !== undefined && this.current?.revision !== undefined && this.current.revision === document?.revision && this.reachable) return;
    this.current = document;
    this.setReachable(true);
    this.onDocument(document);
  }

  setReachable(reachable, error) {
    if (this.reachable === reachable) return;
    this.reachable = reachable;
    this.onReachability(reachable, error);
  }

  /** Poll once. A failure marks the router unreachable until a later success. */
  async refresh() {
    try {
      const result = await fetchCapabilities(this.base, { etag: this.current ? this.etag : undefined, clientName: this.clientName,
        signal: this.lifetime.signal, timeoutMs: this.fetchTimeoutMs, fetchImpl: this.fetchImpl });
      if (this.stopped) return this.current;
      if (result.status === 304) {
        this.setReachable(true);
        return this.current;
      }
      this.etag = result.etag;
      this.accept(result.document);
      return this.current;
    } catch (error) {
      if (!this.stopped) this.setReachable(false, error);
      throw error;
    }
  }

  async follow() {
    let delay = this.retryMs;
    let failures = 0;
    while (!this.stopped) {
      const connection = linkedSignal(this.lifetime.signal);
      let deadTimer;
      const alive = () => {
        clearTimeout(deadTimer);
        deadTimer = setTimeout(() => connection.abort(new Error(`router event stream silent for ${this.deadMs} ms`)), this.deadMs);
      };
      try {
        alive();
        const response = await this.fetchImpl(`${this.base}/v1/router/events`, {
          headers: { accept: "text/event-stream", [CLIENT_NAME_HEADER]: this.clientName }, signal: connection.signal,
        });
        if (!response.ok) {
          // TOO_MANY_SUBSCRIBERS and other refusals: poll instead (§10).
          await response.body?.cancel?.().catch?.(() => {});
          throw new Error(`router events returned HTTP ${response.status}`);
        }
        this.connected = true;
        failures = 0;
        delay = this.retryMs;
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body) {
          alive();
          buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, "\n");
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            let event = "message";
            const data = [];
            for (const line of frame.split("\n")) {
              if (line.startsWith(":")) continue;
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
              else if (line.startsWith("retry:")) {
                const retry = Number(line.slice(6).trim());
                if (Number.isFinite(retry) && retry > 0) this.retryMs = delay = Math.min(retry, this.maxRetryMs);
              }
            }
            if (event === "capabilities" && data.length) {
              let parsed;
              try { parsed = JSON.parse(data.join("\n")); }
              catch { this.logger?.warn?.("router-model-discovery: ignored an unparsable capabilities event"); continue; }
              // The revision is the document's plain ETag, so later polls can revalidate.
              if (nonEmptyString(parsed?.revision)) this.etag = `"${parsed.revision}"`;
              this.accept(parsed);
            }
          }
        }
        throw new Error("router event stream ended");
      } catch (error) {
        if (this.stopped) return;
        if (this.connected) this.logger?.info?.(`router-model-discovery: event stream disconnected (${errorText(error)}); polling every ${Math.round(this.pollMs / 1000)} s`);
        this.connected = false;
        failures += 1;
      } finally {
        clearTimeout(deadTimer);
        connection.abort();
        connection.dispose();
      }
      // While disconnected, poll (If-None-Match) and reconnect with backoff
      // from the stream's retry value up to 30 s.
      await this.refresh().catch(() => undefined);
      const wait = Math.min(delay * 2 ** Math.max(0, failures - 1), this.maxRetryMs, this.pollMs);
      await new Promise(resolve => {
        if (this.stopped) return resolve();
        const done = () => { clearTimeout(timer); this.lifetime.signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, wait);
        this.lifetime.signal.addEventListener("abort", done, { once: true });
      });
    }
  }
}

/** In-process discovery service: one watcher per router, settings convergence and logging. */
export class ResidentDiscovery {
  constructor({ settings, logger, providers = DEFAULT_PROVIDERS, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    clientName = routerClientName(), watchOptions = {}, now = () => Date.now(), echo = true }) {
    // Harness keeps plugin logs in its in-process buffer; transitions are also
    // echoed to the container log so operators see them in `docker logs`.
    const sink = logger;
    const write = (level, message) => {
      try { sink?.[level]?.(message); } catch {}
      if (echo) (level === "warn" ? console.warn : console.log)(`[${new Date().toISOString()}] ${message}`);
    };
    logger = { info: message => write("info", message), warn: message => write("warn", message) };
    Object.assign(this, { settings, logger, providers, pollIntervalMs, clientName, watchOptions, now });
    this.watches = new Map();
    this.holds = new Map();
    this.failures = new Map();
    this.previous = new Map();
    this.lastErrors = new Map();
    this.running = undefined;
    this.dirty = false;
    this.stopped = false;
  }

  start() {
    this.loadPersistedStates();
    this.ensureWatches();
    // Settings can register after this plugin; follow the router as soon as
    // the resident routes are readable rather than at the first reconcile.
    if (this.watches.size === 0) {
      this.startup = setInterval(() => {
        this.ensureWatches();
        if (this.watches.size > 0 || this.stopped) { clearInterval(this.startup); this.loadPersistedStates(); }
      }, 1000);
    }
    this.timer = setInterval(() => { this.ensureWatches(); void this.synchronize("reconcile"); }, this.pollIntervalMs);
    globalThis[ROUTER_CONTRACT_HUB] = this.hub = {
      report: (provider, event) => this.report(provider, event),
      success: (provider) => this.failures.delete(provider),
      state: (provider) => this.previous.get(provider),
    };
    return this;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.startup);
    for (const watch of this.watches.values()) watch.stop();
    this.watches.clear();
    if (globalThis[ROUTER_CONTRACT_HUB] === this.hub) delete globalThis[ROUTER_CONTRACT_HUB];
  }

  loadPersistedStates() {
    let providers = {};
    try { providers = readNamespace(this.settings, "llm-pi-ai")?.providers ?? {}; } catch { return; }
    for (const provider of this.providers) {
      const record = providers[provider]?.residentState;
      if (!this.previous.has(provider) && plainObject(record) && RESIDENT_STATUSES.includes(record.status)) {
        this.previous.set(provider, { service: RESIDENT_SERVICES[provider], status: record.status,
          configuration: record.configuration ?? null, reason: record.reason ?? null });
      }
    }
  }

  baseFor(provider) {
    let providers = {};
    try { providers = readNamespace(this.settings, "llm-pi-ai")?.providers ?? {}; } catch { return undefined; }
    const baseURL = providers[provider]?.baseURL ?? providers["local-ollama"]?.baseURL;
    try { return nonEmptyString(baseURL) ? routerBaseOf(baseURL) : undefined; } catch { return undefined; }
  }

  ensureWatches() {
    if (this.stopped) return;
    const wanted = new Set(this.providers.map(provider => this.baseFor(provider)).filter(Boolean));
    for (const [base, watch] of this.watches) {
      if (!wanted.has(base)) { watch.stop(); this.watches.delete(base); }
    }
    for (const base of wanted) {
      if (this.watches.has(base)) continue;
      const watch = new RouterWatch(base, {
        clientName: this.clientName, logger: this.logger, pollMs: this.pollIntervalMs, ...this.watchOptions,
        onDocument: (document) => {
          if (document?.schema_version !== CAPABILITIES_SCHEMA_VERSION) {
            this.warnOnce(`schema:${base}:${document?.schema_version}`, `router-model-discovery: capabilities schema_version ${document?.schema_version} is not the version ${CAPABILITIES_SCHEMA_VERSION} this Harness was written for`);
          }
          void this.synchronize("revision");
        },
        onReachability: (reachable, error) => {
          this.logger?.[reachable ? "info" : "warn"]?.(`router-model-discovery: router ${reachable ? "reachable" : `unreachable (${errorText(error)})`}`);
          void this.synchronize(reachable ? "reachable" : "unreachable");
        },
      });
      this.watches.set(base, watch);
      watch.start();
    }
  }

  documentFor(baseURL) {
    let base;
    try { base = routerBaseOf(baseURL); } catch { return null; }
    const watch = this.watches.get(base);
    if (!watch || watch.reachable === undefined) return DOCUMENT_PENDING;
    if (watch.reachable !== true) return null;
    return watch.current ?? null;
  }

  warnOnce(key, message) {
    if (this.lastErrors.get(key) === message) return;
    this.lastErrors.set(key, message);
    this.logger?.warn?.(message);
  }

  /** Serialized convergence; a request during a run schedules exactly one more. */
  synchronize(reason) {
    if (this.stopped) return Promise.resolve();
    if (this.running) { this.dirty = true; return this.running; }
    this.running = (async () => {
      try {
        do {
          this.dirty = false;
          await this.synchronizeOnce(reason);
        } while (this.dirty && !this.stopped);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  async synchronizeOnce(reason) {
    const now = this.now();
    for (const [provider, hold] of this.holds) if (hold.until <= now) this.holds.delete(provider);
    let outcome;
    try {
      outcome = await synchronizeRouterSettings(this.settings, {
        providers: this.providers, document: (baseURL) => this.documentFor(baseURL),
        clientName: this.clientName, holds: this.holds, now,
      });
    } catch (error) {
      this.warnOnce("sync", `router-model-discovery: ${errorText(error)}`);
      return;
    }
    // Flush settings/document-updated so open pickers refresh without reload.
    try { this.settings.describe(); } catch { /* best effort */ }
    for (const { provider, error } of outcome.errors) this.warnOnce(`provider:${provider}`, `router-model-discovery: ${provider}: ${errorText(error)}`);
    for (const [provider, { state, recorded }] of outcome.results) {
      this.lastErrors.delete(`provider:${provider}`);
      const hold = this.holds.get(provider);
      if (hold && hold.revision !== undefined && state.status !== hold.status) this.holds.delete(provider);
      if (!this.previous.has(provider) && recorded && RESIDENT_STATUSES.includes(recorded.status)) {
        this.previous.set(provider, { service: RESIDENT_SERVICES[provider], status: recorded.status,
          configuration: recorded.configuration ?? null, reason: recorded.reason ?? null });
      }
      this.logTransition(provider, state, reason);
    }
  }

  logTransition(provider, state, reason) {
    const service = RESIDENT_SERVICES[provider];
    const before = this.previous.get(provider);
    const signature = (value) => value && JSON.stringify([value.status, value.status === "offline" ? value.configuration : value.reason]);
    if (signature(before) !== signature(state)) {
      this.logger?.info?.(`router-model-discovery: ${service}: ${before ? describeStatus(before) : "unknown"} → ${describeStatus(state)}`);
    }
    if (state.served && before?.served && before.served !== state.served) {
      // Canonical IDs are information only; they are never stored or compared for routing.
      this.logger?.info?.(`router-model-discovery: ${service}: served model changed from ${before.served} to ${state.served} (${reason})`);
    }
    const limits = state.capabilities;
    const previousLimits = before?.capabilities;
    if (limits && previousLimits && (limits.contextWindow !== previousLimits.contextWindow || limits.maxConcurrency !== previousLimits.maxConcurrency)) {
      this.logger?.info?.(`router-model-discovery: ${service}: limits recomputed: context budget ${previousLimits.contextWindow} → ${limits.contextWindow}, slots ${previousLimits.maxConcurrency} → ${limits.maxConcurrency}`);
    }
    this.previous.set(provider, { service, status: state.status, configuration: state.configuration, reason: state.reason,
      served: state.served ?? before?.served, capabilities: limits ?? previousLimits });
  }

  /** Request-time evidence from the adapter (§10); the document stays authoritative. */
  report(provider, event = {}) {
    if (this.stopped || !this.providers.includes(provider)) return;
    const code = event.code;
    const base = this.baseFor(provider);
    const watch = base ? this.watches.get(base) : undefined;
    const revision = watch?.current?.revision;
    const now = this.now();
    const service = RESIDENT_SERVICES[provider];
    if (code === "SERVICE_OFFLINE" || code === "MODEL_NOT_FOUND") {
      const configuration = /configuration "([^"]+)"/.exec(event.message ?? "")?.[1] ?? watch?.current?.configuration?.id ?? null;
      this.holds.set(provider, code === "SERVICE_OFFLINE"
        ? { status: "offline", reason: "SERVICE_OFFLINE", configuration, revision, until: now + REQUEST_HOLD_MS }
        : { status: "unavailable", reason: "not offered by the router (MODEL_NOT_FOUND)", revision, until: now + REQUEST_HOLD_MS });
      if (code === "MODEL_NOT_FOUND") this.logger?.warn?.(`router-model-discovery: ${service}: router answered MODEL_NOT_FOUND; the service ID may be stale`);
    } else if (code === "BACKEND_UNAVAILABLE") {
      const entry = this.failures.get(provider);
      const failures = entry && now - entry.first < BACKEND_FAILURE_WINDOW_MS ? { first: entry.first, count: entry.count + 1 } : { first: now, count: 1 };
      this.failures.set(provider, failures);
      if (failures.count >= BACKEND_FAILURE_THRESHOLD) {
        this.holds.set(provider, { status: "unavailable", reason: "backend unavailable (BACKEND_UNAVAILABLE)", revision, until: now + REQUEST_HOLD_MS });
        this.failures.delete(provider);
      }
    } else if (code !== "BACKEND_DRAINING" && code !== "MAINTENANCE_MODE") {
      return;
    }
    // The document can lag a request; re-read it now, then converge.
    void (watch ? watch.refresh().catch(() => undefined) : Promise.resolve()).then(() => this.synchronize(`request ${code}`));
  }
}

/** Cordis plugin entry point. */
export function apply(ctx, config = {}) {
  const configured = Array.isArray(config.providers) ? config.providers.filter(nonEmptyString) : [];
  const providers = configured.length ? configured.filter(provider => Object.hasOwn(RESIDENT_SERVICES, provider)) : DEFAULT_PROVIDERS;
  const configuredInterval = Number(config.pollIntervalMs);
  const pollIntervalMs = Number.isFinite(configuredInterval)
    ? Math.max(MIN_POLL_INTERVAL_MS, Math.trunc(configuredInterval))
    : DEFAULT_POLL_INTERVAL_MS;
  const clientName = routerClientName({ instance: config.clientInstance });
  // Existing sessions recorded their route with old IDs. Rewrite each outgoing
  // request to the service ID so its durable request header migrates too.
  if (typeof ctx.on === "function") {
    ctx.on("agent/request", async (_payload, next) => migrateResidentRoute(await next(), providers), { prepend: true });
  }
  // Follow DSH's canonical optional-settings pattern. The plugin itself loads
  // regardless of service ordering; this scoped callback activates whenever
  // the settings provider is available and owns all timer cleanup.
  ctx.inject(["settings"], (sctx) => {
    const discovery = new ResidentDiscovery({ settings: sctx.settings, logger: sctx.logger, providers, pollIntervalMs,
      clientName, watchOptions: plainObject(config.watch) ? config.watch : {} });
    sctx.effect(() => {
      discovery.start();
      return () => discovery.stop();
    }, "router model discovery synchronization");
  });
}
