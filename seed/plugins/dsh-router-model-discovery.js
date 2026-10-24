/** Resident model discovery under the LLM Router client contract, version 1.2.
 *
 * docs/llm-router-contract.md is authoritative, and it is data-driven: the
 * router publishes its catalog of services in `/v1/router/capabilities`, and
 * that document — not a list written in Harness — decides which models a person
 * may choose and what each of them is called. Harness reads the document at
 * startup, follows `/v1/router/events` for its lifetime and polls while the
 * stream is down, and writes one provider per router whose models are exactly
 * the service IDs that router currently offers (§3, §4). Names come from what
 * the publisher published: `metadata.alias_display_names` for the name being
 * offered, and the model's own `display_name`/`display_name_qualified`
 * otherwise. Harness invents no model names and keeps no service list of its
 * own; a service the runtime adds appears in the picker on the next revision,
 * and one it retires stays visible only as its recorded state.
 *
 * Each service is evaluated on its own; one model's state never blocks updates
 * to another. Fallback is deliberately disabled (§5): an unusable model stays
 * visible, is labelled with exactly one state and fails fast at dispatch, while
 * a draining router makes requests wait.
 *
 * `trial` is opt-in (§3: "it is never the configuration the operator falls
 * into"). The contract names it, so the list is configuration with that default
 * rather than a Harness concept: `optInServices` in the plugin settings. An
 * opt-in service is never a default, never inherits another service's state,
 * and is never a fallback target; a session reaches it only when a human
 * selects it, and then stays there or fails.
 */
import { hostname } from "node:os";

export const name = "router-model-discovery";

/**
 * The provider route that carries a router's published catalog. The id is
 * persisted in every session, default and compaction policy from before the
 * contract existed, so it stays; what it offers is written from the document.
 */
export const ROUTER_PROVIDER = "local-ollama";
const DEFAULT_PROVIDERS = Object.freeze([ROUTER_PROVIDER]);
/**
 * Provider routes written before a router's catalog drove the model list — one
 * route per service, each with one model. They exist only to rewrite persisted
 * selections onto the catalog route, which settings drops once nothing selects
 * it. `local-ollama` is not one of them: it survived as the catalog route, and
 * after the change it legitimately serves several models, so its selections
 * must be left alone.
 */
export const RETIRED_ROUTES = Object.freeze({ "local-everyday": "nighttime", "local-trial": "trial" });
/**
 * Services no automated path may select (§3). `trial` is the one the contract
 * names; the list is configuration so a future opt-in name is a settings edit,
 * not a Harness release. They are never a default, never inherit another
 * service's state, never a fallback target, and never picked by migration or
 * verification. A human selects them, or they stay unused.
 */
export const OPT_IN_SERVICES = Object.freeze(["trial"]);
/** The reserved compatibility alias: §3 says it is not a service — never offer it. */
const COMPATIBILITY_ALIAS = "local-active";

/** Whether only a human selection may put a session on this service. */
export function isOptInService(service, optInServices = OPT_IN_SERVICES) {
  return (Array.isArray(optInServices) ? optInServices : OPT_IN_SERVICES).includes(service);
}
/**
 * The router routes this release manages, from the plugin's `providers` config.
 * A list written for one-route-per-service releases names the retired routes;
 * every one of those carried the same router base URL, so such a list is read
 * as the single catalog route those releases pointed at. Anything else is
 * obeyed: a deployment that names a second route gets it discovered too.
 */
export function resolveProviderList(configuredProviders) {
  const configured = Array.isArray(configuredProviders) ? configuredProviders.filter(nonEmptyString) : [];
  const extra = configured.filter(provider => !Object.hasOwn(RETIRED_ROUTES, provider));
  if (extra.length === 0) return [...DEFAULT_PROVIDERS];
  return [...new Set([ROUTER_PROVIDER, ...extra])];
}
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
/** Request-failure accounting is per service of a route. */
function failureKey(provider, model) {
  return nonEmptyString(model) ? `${provider}\u0000${model}` : provider;
}

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
 * Such a router runs the legacy single-marker mode, where the reserved alias
 * `local-active` is not a service but names the one model the router has active
 * (§3, 1.2). This deployment reads that active model as its `daytime` service —
 * a choice about the managed topology, not a claim that the alias is an alias of
 * `daytime`; in a published resident catalog an undeclared `local-active` is a 404.
 * The result is marked
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
    // A pre-contract listing names only the two services that existed before
    // the contract. Any other row, including a `trial` row, stays unaddressable
    // and is dropped: a route is never created for a service the router does
    // not offer, and the opt-in trial is never reached through legacy aliasing.
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
 * The one name a published row is chosen by (§3, §4): its service ID. A canonical
 * model ID is not a choice, and neither is the reserved compatibility alias, so a
 * row the catalog gives no service ID of its own is never surfaced as a model
 * someone can choose. The aliases a row carries are other names for that same
 * model: they address it, and they are never a second row of their own.
 */
function serviceName(row) {
  if (!plainObject(row)) return undefined;
  for (const name of [row.service, ...(Array.isArray(row.aliases) ? row.aliases : [])]) {
    if (nonEmptyString(name) && name !== row.id && name !== COMPATIBILITY_ALIAS) return name;
  }
  return undefined;
}

/** Every name one published row answers to, in published order. */
function rowNames(row) {
  return [...new Set([row.service, ...(Array.isArray(row.aliases) ? row.aliases : [])].filter(nonEmptyString))];
}

/**
 * The service a name addresses (§3): a request may name a model by its service ID
 * or by any alias, and every one of those names is the same model. A name this
 * document gives no model for addresses nothing.
 */
export function resolveServiceName(document, name) {
  if (!nonEmptyString(name)) return undefined;
  for (const row of Array.isArray(document?.models) ? document.models : []) {
    const service = serviceName(row);
    if (service !== undefined && rowNames(row).includes(name)) return service;
  }
  return undefined;
}

/**
 * The title a published row gives its model, taken verbatim: `display_name_qualified`
 * is the label a router says a picker renders, `display_name` the title a router
 * older than that field publishes. Harness composes nothing of its own here — no
 * state, no marker, no qualifier — because the list of models is the router's own
 * naming of them.
 */
function publishedTitle(row) {
  const metadata = plainObject(row?.metadata) ? row.metadata : {};
  for (const title of [row?.display_name_qualified, row?.display_name, metadata.display_name]) {
    if (nonEmptyString(title)) return title;
  }
  return undefined;
}

/** The names a stopped service answers, in published order, minus what is not a choice. */
function offlineNames(row) {
  const names = [...(Array.isArray(row.aliases) ? row.aliases : [])];
  return [...new Set(names.filter(nonEmptyString))].filter(name => name !== row.model && name !== COMPATIBILITY_ALIAS);
}

/**
 * What one router publishes, in publication order: one entry per model its
 * document lists, then the services its active configuration deliberately stops.
 * Aliases are not entries (§3), and neither is a name the document has stopped
 * mentioning — a row for that would be a model of Harness's own, which is what
 * this contract forbids. Remembered names appear only while the router is not
 * answering at all, where nothing can be read (§7: keep the last catalog and
 * mark it stale).
 */
export function routerServices(document, { known = [], optInServices = OPT_IN_SERVICES, routerState = null } = {}) {
  const configuration = nonEmptyString(document?.configuration?.id) ? document.configuration.id : null;
  const services = new Map();
  const admitting = document ? document.router?.accepting_requests !== false : false;
  const unavailableReason = routerState?.status === "unavailable" ? routerState.reason : "router unreachable";
  if (document === null || document === undefined) {
    // Nothing can be read from a router that is not answering: every name this
    // route already carries is unavailable, and the route-level state says why.
    for (const service of known) {
      // §3: the reserved compatibility alias is not a service, so a route that
      // still carries it does not keep it as a model even while the router is down.
      if (service === COMPATIBILITY_ALIAS) continue;
      services.set(service, { service, status: "unavailable", reason: unavailableReason, configuration: null, served: null,
        nsfw: null, label: undefined, optIn: isOptInService(service, optInServices) });
    }
    return { services: [...services.values()], configuration: null, problem: undefined, document: null,
      route: routerState ?? routerRouteState(null) };
  }
  const problem = documentProblem(document);
  if (problem) return { services: [], configuration, problem, document, route: routerRouteState(document) };
  const rows = Array.isArray(document.models) ? document.models.filter(plainObject) : [];
  const owners = new Map();
  for (const row of rows) {
    const service = serviceName(row);
    // §3: a row the catalog gives no service ID for offers nothing to choose.
    if (service === undefined) continue;
    if (owners.has(service)) owners.get(service).push(row);
    else owners.set(service, [row]);
  }
  const offline = new Map((Array.isArray(document.offline_services) ? document.offline_services : [])
    .filter(plainObject).flatMap(row => offlineNames(row).map(name => [name, row])));
  for (const [service, published] of owners) {
    const row = published[0];
    const nsfw = row.nsfw === true ? true : row.nsfw === false ? false : null;
    const record = { service, configuration, nsfw, served: nonEmptyString(row.id) ? row.id : null,
      label: publishedTitle(row), aliases: rowNames(row), optIn: isOptInService(service, optInServices),
      // The document row this service was read from. Verification reads it to
      // check what a browser may send; nothing here is persisted as settings.
      row };
    services.set(service, record);
    // A draining or maintained router accepts nothing. Wait, never switch (§5, §7).
    if (!admitting) {
      Object.assign(record, { status: "switching", reason: document.router?.maintenance === true ? "maintenance" : "draining" });
      continue;
    }
    // Two rows offering one service ID contradict each other about what choosing
    // it means, and which one answers is not Harness's to guess.
    if (published.length > 1) {
      Object.assign(record, { status: "incomplete", reason: `ambiguous router service "${service}"` });
      continue;
    }
    const stopped = offline.get(service);
    if (stopped) {
      Object.assign(record, { status: "offline", served: null,
        reason: nonEmptyString(stopped.reason) ? stopped.reason : "offline_service",
        label: nonEmptyString(stopped.display_name) ? stopped.display_name : record.label });
      continue;
    }
    if (row.available !== true) {
      Object.assign(record, { status: "unavailable", reason: "backend unavailable", served: null });
      continue;
    }
    try {
      record.capabilities = residentCapabilities({ model: row, metadata: row.metadata, service });
      record.status = "available";
      record.reason = null;
    } catch (error) {
      // A pre-contract router publishes no complete metadata; its service
      // stays usable with the stored limits, as before discovery existed.
      if (document.legacy === true) {
        Object.assign(record, { status: "available", reason: "legacy router without published limits", legacy: true });
      } else {
        Object.assign(record, { status: "incomplete", reason: errorText(error) });
      }
    }
  }
  // A service the configuration stops without listing it as a model is still the
  // router naming one, so it appears as the router names it: with its published
  // title where it has one, and no title of Harness's invention.
  for (const [service, stopped] of offline) {
    if (services.has(service)) continue;
    services.set(service, { service, status: admitting ? "offline" : "switching", served: null, configuration,
      nsfw: null, reason: admitting && nonEmptyString(stopped.reason) ? stopped.reason : admitting ? "offline_service"
        : document.router?.maintenance === true ? "maintenance" : "draining",
      label: nonEmptyString(stopped.display_name) ? stopped.display_name : undefined,
      aliases: offlineNames(stopped), optIn: isOptInService(service, optInServices) });
  }
  return { services: [...services.values()], configuration, problem: undefined, document, route: routerRouteState(document) };
}


/**
 * Evaluate one service from the current document, independently of every other
 * service. `document === null` means the router is unreachable. The result
 * carries the canonical model only as information; it is never persisted.
 */
export function residentStatus(document, service, options = {}) {
  // §3: a name may be the service ID or an alias of it, and both are one model,
  // so the state of the service the name addresses is the state of that request.
  const addressed = resolveServiceName(document, service) ?? service;
  const catalog = routerServices(document, { ...options, known: options.known ?? [addressed] });
  const found = catalog.services.find(row => row.service === addressed);
  if (found) {
    if (catalog.problem) return { service, status: "incomplete", reason: catalog.problem, configuration: null, nsfw: null };
    return found;
  }
  if (catalog.problem) return { service, status: "incomplete", reason: catalog.problem, configuration: null, nsfw: null };
  return { service, status: "unavailable", reason: "not offered by the router", configuration: catalog.configuration,
    nsfw: null, served: null, label: service, optIn: isOptInService(service, options.optInServices) };
}


/** Limits and features of the model that will actually serve the service. */
export function residentCapabilities({ model, metadata, service }) {
  // §6: everything the router publishes about a model is validated before any of
  // it reaches settings, and it must agree with the catalog row it belongs to.
  // A disagreement is reported as incomplete metadata, never resolved by guess.
  validateRouterMetadata(metadata);
  if (metadata.context_window !== model.context_window) {
    throw new Error(`router metadata context_window (${metadata.context_window}) disagrees with the model listing (${model.context_window})`);
  }
  if (metadata.active_request_limit !== model.slots) {
    throw new Error(`router metadata active_request_limit (${metadata.active_request_limit}) disagrees with the model listing slots (${model.slots})`);
  }
  const input = metadata.input_modalities.filter(value => DSH_INPUT_MODALITIES.has(value));
  if (!input.includes("text")) throw new Error("router advertises no input modality Harness can represent");
  const reserve = metadata.context_safety_reserve ?? 0;
  return {
    // Admission requires input + output + reserve <= context_window (§8), so
    // the Harness budget and compaction thresholds use the remainder.
    contextWindow: model.context_window - reserve,
    contextSafetyReserve: reserve,
    maxConcurrency: model.slots,
    maxTokens: metadata.max_output_tokens,
    input,
    service,
    reasoningEfforts: dshReasoningEfforts(metadata.reasoning),
  };
}

/** The single picker label for one service in its current state. */
export function residentLabel(state) {
  // The router's title, verbatim. Availability is not part of a name: the route's
  // gating and the model's recorded state say what a title cannot, and a title
  // Harness had to edit would be a model the router did not publish.
  if (nonEmptyString(state?.label)) return state.label;
  return nonEmptyString(state?.service) ? state.service : "Model";
}

/**
 * The name a route carries for one service, and the only rule for it: the title
 * the router publishes for the model that answers that service, verbatim, for as
 * long as the router publishes one. Where it publishes no title — a router older
 * than the field, or no document at all — the row keeps the name it was given.
 * Nothing is ever appended: a state, a marker or a qualifier written into a title
 * is a model the router did not publish, and a remembered title staying one round
 * longer while the router is unreachable is the last catalog §7 asks for, not a
 * claim that the model is answering.
 */
export function routerModelName(service, storedName) {
  if (nonEmptyString(service.label)) return service.label;
  return nonEmptyString(storedName) ? storedName : service.service;
}

/** The dispatch failure shown when a blocked service is asked to serve. */
export function residentMessage(state, { optInServices = OPT_IN_SERVICES } = {}) {
  const label = nonEmptyString(state.label) ? state.label : state.service;
  // An opt-in service is chosen deliberately, so its advice never suggests
  // moving to another model: the session stays on it or fails, and only a
  // human may move it off. §5 deviation: nothing falls back in either direction.
  const advice = isOptInService(state.service, optInServices)
    ? `${label} is an opt-in model: Harness never selects it and never moves a session off it. Select another model yourself, or retry when it returns.`
    : `Select another model, or retry when ${label} returns; Harness reconnects automatically.`;
  switch (state.status) {
    case "offline":
      return `${label} is offline in router configuration ${state.configuration ? `"${state.configuration}"` : "(unknown)"}${state.reason ? ` (${state.reason})` : ""}. ${advice}`;
    case "incomplete":
      return `${label} is unavailable: the router published incomplete metadata for it (${state.reason}). ${advice}`;
    case "switching":
      return `The router is switching configuration (${state.reason}); requests to ${label} wait and retry without changing models.`;
    case "unavailable":
      if (state.reason === "not offered by the router" && isOptInService(state.service, optInServices)) {
        return `${label} is unavailable: the router's current configuration does not offer it. ${advice}`;
      }
      return state.reason === "router unreachable" || state.reason === "not offered by the router"
        ? `${label} is unavailable: the ${state.reason === "router unreachable" ? "router is unreachable" : "router does not offer it"}. ${advice}`
        : `${label} is unavailable: ${state.reason}. ${advice}`;
    default:
      return `${label} is available.`;
  }
}

/** Persisted, canonical-ID-free summary that the adapter and picker read. */
export function residentStateRecord(state, storedName, { optInServices = OPT_IN_SERVICES } = {}) {
  const published = state.status === "available" && state.capabilities !== undefined;
  return {
    service: state.service,
    status: state.status,
    label: nonEmptyString(state.label) ? state.label
      : nonEmptyString(storedName) ? storedName : residentLabel(state),
    ...(state.status === "available" ? {} : { message: residentMessage(state, { optInServices }) }),
    configuration: state.configuration ?? null,
    reason: state.reason ?? null,
    limits: published ? "current" : state.status === "available" ? "stored" : "stale",
    nsfw: state.nsfw ?? null,
  };
}

/**
 * The router-level state of one provider: whether its router is answering,
 * admitting, and publishing a usable document. It gates every model the router
 * offers, which is why it lives on the route and not on a model row.
 */
export function routerRouteState(document) {
  if (document === null || document === undefined) return { status: "unavailable", reason: "router unreachable", configuration: null };
  const problem = documentProblem(document);
  if (problem) return { status: "incomplete", reason: problem, configuration: null };
  if (document.router?.accepting_requests !== true) {
    return { status: "switching", reason: document.router?.maintenance === true ? "maintenance" : "draining",
      configuration: nonEmptyString(document.configuration?.id) ? document.configuration.id : null };
  }
  return { status: "available", reason: null, configuration: nonEmptyString(document.configuration?.id) ? document.configuration.id : null };
}

/** The service the document names as its default, or the first one it offers. */
function defaultService(document, catalog) {
  const models = Array.isArray(document?.models) ? document.models : [];
  const preferred = nonEmptyString(document?.default_model) ? models.find(row => row?.id === document.default_model) : undefined;
  const names = nonEmptyString(preferred?.service) ? [preferred.service, ...(Array.isArray(preferred.aliases) ? preferred.aliases : [])] : [];
  for (const service of catalog.services) if (names.includes(service.service) || service.service === preferred?.service) return service.service;
  return catalog.services.find(service => service.status === "available")?.service ?? catalog.services[0]?.service;
}

/** The name a router publishes for itself, or the address it answers at. */
/**
 * The name a route is titled with: the name the router publishes for itself, or
 * the address it answers at when it publishes none. Undefined only when there is
 * no document to read either, where a stored title is kept.
 */
export function routerName(document, baseURL) {
  if (nonEmptyString(document?.router?.name)) return document.router.name;
  if (!document) return undefined;
  try { return new URL(baseURL).hostname; } catch { return undefined; }
}

/**
 * Bring one Harness route in line with the catalog one router published: the
 * models it offers, each with the limits, label and state of the service that
 * answers it, and the route's own admission state. Explicit preferences,
 * credential references and unrelated fields survive, on the route and on every
 * model row a person or an override has touched.
 *
 * `catalog` is the `routerServices` result for this route's document, with the
 * request-time holds already applied.
 */
export function planRouterProvider({ name: provider, catalog, stored, resolved, clientName, optInServices = OPT_IN_SERVICES }) {
  const source = plainObject(stored) ? stored : plainObject(resolved) ? resolved : undefined;
  if (!source) throw new Error(`cannot manage router route "${provider}" without stored or resolved settings`);
  const document = catalog.document;
  const route = catalog.route;
  const rows = Array.isArray(source.models) ? source.models : [];
  const states = {};
  const models = catalog.services.map((service) => {
    const row = rows.find(candidate => candidate?.id === service.service) ?? { name: service.service };
    const next = clone(row);
    next.id = service.service;
    const published = service.status === "available" && service.capabilities !== undefined;
    // The name follows the router: its published title while a model answers the
    // service, its own name and state when nothing does (§5).
    next.name = routerModelName(service, next.name);
    if (published) {
      const capabilities = service.capabilities;
      Object.assign(next, {
        contextWindow: capabilities.contextWindow,
        maxTokens: capabilities.maxTokens,
        input: capabilities.input,
        reasoningEfforts: capabilities.reasoningEfforts,
      });
    }
    // Where nothing serves the name, limits stay as they were, marked stale.
    states[service.service] = {
      ...residentStateRecord(service, next.name, { optInServices }),
      ...(service.legacy === true ? { legacy: true } : {}),
    };
    return next;
  });
  const next = {
    ...clone(source),
    api: "openai-responses",
    baseURL: source.baseURL ?? resolved?.baseURL,
    headers: withClientName(source.headers, clientName),
    models,
    residentUnavailable: route.status === "unavailable" || route.status === "incomplete",
    residentState: {
      status: route.status, reason: route.reason ?? null, configuration: route.configuration,
      services: catalog.services.map(service => ({ service: service.service, status: service.status })),
      // A request that names no configured model is served by what the router
      // itself calls its default, which is data from the document.
      default: defaultService(document, catalog),
    },
    residentStates: states,
  };
  const publishedName = routerName(document, next.baseURL);
  if (nonEmptyString(publishedName)) next.displayName = publishedName;
  // A Harness route is limited as a whole, so it is set to the slots of every
  // distinct model the router offers — aliases of one model share its slots, and
  // the router's own queue per model remains the authority (§8).
  const capacity = new Map();
  for (const service of catalog.services) {
    if (!service.capabilities) continue;
    const model = nonEmptyString(service.served) ? service.served : service.service;
    capacity.set(model, Math.max(capacity.get(model) ?? 0, service.capabilities.maxConcurrency));
  }
  const slots = [...capacity.values()].reduce((total, count) => total + count, 0);
  if (slots > 0) next.maxConcurrency = slots;
  else if (!Number.isSafeInteger(next.maxConcurrency) || next.maxConcurrency < 1) next.maxConcurrency = 1;
  // Keep explicit client policy separate from the router's raw default.
  if (next.reasoning === undefined && catalog.services.some(service => service.capabilities?.reasoningEfforts?.medium)) {
    next.reasoning = "medium";
  }
  return next;
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

/**
 * Rewrite a persisted selection written before a router's catalog drove the
 * model list. Those releases kept one provider route per service, so a stored
 * `{provider: "local-everyday", model: "nighttime"}` is the catalog model
 * `nighttime` of the single router route. A route that survived the change is
 * never rewritten: after it, one route legitimately serves several models.
 */
export function migrateResidentRoute(config) {
  if (!plainObject(config) || !Object.hasOwn(RETIRED_ROUTES, config.provider)) return config;
  const service = RETIRED_ROUTES[config.provider];
  return { ...config, provider: ROUTER_PROVIDER, ...(!nonEmptyString(config.model) || config.model !== service ? { model: service } : {}) };
}

function withClientName(headers, clientName) {
  const next = Object.fromEntries(Object.entries(plainObject(headers) ? headers : {})
    .filter(([header]) => header.toLowerCase() !== CLIENT_NAME_HEADER.toLowerCase()));
  next[CLIENT_NAME_HEADER] = clientName;
  return next;
}

/**
 * The service names a route already carries a model row for, plus the names of
 * the retired one-route-per-service releases still in settings. A name listed
 * here keeps its row and its recorded state when a router stops publishing it
 * (§5: a stated failure, not a vanished model); on a deployment that never had
 * those routes nothing is inherited, and the catalog offers exactly what the
 * router publishes.
 */
function knownServices(providers, provider) {
  const all = plainObject(providers) ? providers : {};
  // The names this route already carries, plus — for the catalog route alone —
  // the names of the one-route-per-service releases it replaces. Another router's
  // route keeps its own names, so its models are not offered as missing here.
  const sources = [provider, ...(provider === ROUTER_PROVIDER ? Object.keys(RETIRED_ROUTES) : [])];
  const names = new Set();
  for (const id of sources) {
    for (const row of Array.isArray(all[id]?.models) ? all[id].models : []) if (nonEmptyString(row?.id)) names.add(row.id);
  }
  return [...names];
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

/** Request-time contradictions of the document, applied to every service of one route. */
function applyHolds(catalog, provider, holds, revision, now) {
  if (!holds || holds.size === 0 || catalog.services.length === 0) return catalog;
  const route = holds.get(provider);
  catalog.services = catalog.services.map(service =>
    effectiveState(service, holds.get(`${provider}\u0000${service.service}`) ?? (service.status === "available" ? route : undefined),
      revision, now));
  return catalog;
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
  now = Date.now(), fetchOptions = {}, onFetchError, optInServices = OPT_IN_SERVICES,
} = {}) {
  const initial = readNamespace(settingsService, "llm-pi-ai");
  if (!plainObject(initial)) throw new Error('Harness settings namespace "llm-pi-ai" is not registered yet');
  const seed = initial.providers?.[ROUTER_PROVIDER];
  if (!plainObject(seed)) throw new Error(`Missing the ${ROUTER_PROVIDER} router route`);
  const managed = [...new Set(providers.filter(nonEmptyString))];
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
      const baseURL = resolved?.baseURL ?? stored.providers?.[provider]?.baseURL ?? seed?.baseURL;
      if (!nonEmptyString(baseURL)) throw new Error(`provider ${provider} has no baseURL`);
      routerBaseOf(baseURL);
      const current = await documentFor(baseURL);
      if (current === DOCUMENT_PENDING) continue;
      const catalog = applyHolds(routerServices(current, { known: knownServices(stored.providers, provider), optInServices }),
        provider, holds, current?.revision, now);
      const next = planRouterProvider({ name: provider, catalog, stored: stored.providers?.[provider], resolved,
        clientName, optInServices });
      const latest = readNamespace(settingsService, "llm-pi-ai");
      if (!sameJson(latest.providers?.[provider], resolved)) {
        throw new Error("router settings changed during discovery; retrying on the next refresh");
      }
      const recorded = plainObject(resolved?.residentStates) ? resolved.residentStates : {};
      results.set(provider, { catalog, route: catalog.route, next, changed: false,
        services: catalog.services.map(entry => ({ service: entry.service, state: entry,
          recorded: recorded[entry.service] })) });
      const previous = storedNamespace(settingsService, "llm-pi-ai")?.providers?.[provider];
      if (!sameJson(previous, next)) {
        await settingsService.mutate("llm-pi-ai", [{ op: "set", path: ["providers", provider], value: next }]);
        results.get(provider).changed = true;
      }
      // §3: an alias and a service ID name one model, so a default selection that
      // names an alias keeps naming that model under the name the router publishes
      // as its service. This is the same model under its published name, never a
      // move to another one (§5).
      await retargetAliasSelection(settingsService, provider, current);
    } catch (error) {
      errors.push({ provider, error });
    }
  }
  for (const [step, name] of [[migrateDefaultSelection, "agent-default-model"], [retireLegacyRoutes, "legacy-router-routes"]]) {
    try {
      await step(settingsService, optInServices);
    } catch (error) {
      errors.push({ provider: name, error });
    }
  }
  return { results, errors };
}

/**
 * Move a saved default off a route that no longer exists. It never changes
 * which service the default names, and it never moves onto an opt-in one: a
 * session reaches an opt-in service only when a human selects it, and no fresh
 * install, settings restore or unreachable-router state may select it here.
 */
async function migrateDefaultSelection(settingsService, optInServices = OPT_IN_SERVICES) {
  const settings = readNamespace(settingsService, "llm-pi-ai");
  const retired = settings.providers?.["local-ollama-256k"];
  const ownedRetired = plainObject(retired) && retired.baseURL === settings.providers?.[ROUTER_PROVIDER]?.baseURL &&
    retired.models?.length === 1 && ["local-active", "daytime"].includes(retired.models[0]?.id);
  const selected = readNamespace(settingsService, "agent-default-model");
  let nextSelection;
  if (ownedRetired && selected?.provider === "local-ollama-256k") {
    // The retired route sent the service the surviving route still answers that name with.
    nextSelection = { ...selected, provider: ROUTER_PROVIDER, model: "daytime" };
  } else if (plainObject(selected)) {
    const migrated = migrateResidentRoute(selected);
    if (migrated !== selected) nextSelection = migrated;
  }
  if (nextSelection && isOptInService(nextSelection.model, optInServices) &&
      !isOptInService(selected?.model, optInServices)) {
    throw new Error(`refusing to move the default selection onto opt-in service ${nextSelection.model}`);
  }
  if (ownedRetired) await settingsService.mutate("llm-pi-ai", [{ op: "unset", path: ["providers", "local-ollama-256k"] }]);
  if (nextSelection) {
    const ops = Object.entries(nextSelection).filter(([key, value]) => !sameJson(selected[key], value))
      .map(([key, value]) => ({ op: "set", path: [key], value }));
    if (ops.length) await settingsService.mutate("agent-default-model", ops);
  }
}

/**
 * Write a default selection that names an alias under the service the router
 * publishes for that same model. A picker row exists for the service (§3), and a
 * selection naming a name that is not a row would leave the session pointing at a
 * model the picker does not show.
 */
async function retargetAliasSelection(settingsService, provider, document) {
  const selected = readNamespace(settingsService, "agent-default-model");
  if (selected?.provider !== provider || !nonEmptyString(selected.model)) return;
  const service = resolveServiceName(document, selected.model);
  if (service === undefined || service === selected.model) return;
  await settingsService.mutate("agent-default-model", [{ op: "set", path: ["model"], value: service }]);
}

/**
 * Drop the one-route-per-service routes. Each carries no state of its own once
 * the catalog route lists its service, and leaving it behind would leave a
 * second copy of the same router in the picker.
 */
async function retireLegacyRoutes(settingsService) {
  const settings = readNamespace(settingsService, "llm-pi-ai");
  for (const provider of Object.keys(RETIRED_ROUTES)) {
    if (plainObject(settings.providers?.[provider])) {
      await settingsService.mutate("llm-pi-ai", [{ op: "unset", path: ["providers", provider] }]);
    }
  }
}/**
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
    clientName = routerClientName(), watchOptions = {}, now = () => Date.now(), echo = true,
    optInServices = OPT_IN_SERVICES }) {
    // Harness keeps plugin logs in its in-process buffer; transitions are also
    // echoed to the container log so operators see them in `docker logs`.
    const sink = logger;
    const write = (level, message) => {
      try { sink?.[level]?.(message); } catch {}
      if (echo) (level === "warn" ? console.warn : console.log)(`[${new Date().toISOString()}] ${message}`);
    };
    logger = { info: message => write("info", message), warn: message => write("warn", message) };
    Object.assign(this, { settings, logger, providers, pollIntervalMs, clientName, watchOptions, now, optInServices });
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
      success: (provider, model) => this.failures.delete(failureKey(provider, model)),
      state: (provider, model) => this.previous.get(`${provider}\u0000${model}`),
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
    for (const [provider, entry] of Object.entries(providers)) {
      if (![...this.providers, ...Object.keys(RETIRED_ROUTES)].includes(provider)) continue;
      // States are recorded per model on the route, which is where the plan
      // writes them; a restart resumes from them instead of announcing every
      // service as newly recorded.
      for (const [service, record] of Object.entries(plainObject(entry?.residentStates) ? entry.residentStates : {})) {
        const key = `${provider}\u0000${service}`;
        if (!nonEmptyString(service) || this.previous.has(key) || !plainObject(record) ||
            !RESIDENT_STATUSES.includes(record.status)) continue;
        this.previous.set(key, { service, status: record.status, configuration: record.configuration ?? null,
          reason: record.reason ?? null });
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
    for (const [key, hold] of this.holds) if (hold.until <= now) this.holds.delete(key);
    let outcome;
    try {
      outcome = await synchronizeRouterSettings(this.settings, {
        providers: this.providers, document: (baseURL) => this.documentFor(baseURL),
        clientName: this.clientName, holds: this.holds, now, optInServices: this.optInServices,
      });
    } catch (error) {
      this.warnOnce("sync", `router-model-discovery: ${errorText(error)}`);
      return;
    }
    // Flush settings/document-updated so open pickers refresh without reload.
    try { this.settings.describe(); } catch { /* best effort */ }
    for (const { provider, error } of outcome.errors) this.warnOnce(`provider:${provider}`, `router-model-discovery: ${provider}: ${errorText(error)}`);
    for (const [provider, { services, route }] of outcome.results) {
      this.lastErrors.delete(`provider:${provider}`);
      const routeHold = this.holds.get(provider);
      if (routeHold && routeHold.revision !== undefined && route.status !== routeHold.status) this.holds.delete(provider);
      for (const { service, state, recorded } of services) {
        const key = `${provider}\u0000${service}`;
        const hold = this.holds.get(key);
        if (hold && hold.revision !== undefined && state.status !== hold.status) this.holds.delete(key);
        if (!this.previous.has(key) && plainObject(recorded) && RESIDENT_STATUSES.includes(recorded.status)) {
          this.previous.set(key, { service, status: recorded.status, configuration: recorded.configuration ?? null,
            reason: recorded.reason ?? null });
        }
        this.logTransition(provider, service, state, reason);
      }
    }
  }

  logTransition(provider, service, state, reason) {
    const key = `${provider}\u0000${service}`;
    const before = this.previous.get(key);
    const signature = (value) => value && JSON.stringify([value.status, value.status === "offline" ? value.configuration : value.reason]);
    if (signature(before) !== signature(state)) {
      this.logger?.info?.(`router-model-discovery: ${service}: ${before ? describeStatus(before) : "unknown"} → ${describeStatus(state)}`);
    }
    // A catalog can gain or lose a service without anything else changing.
    if (before === undefined && state.status !== "available") {
      this.logger?.info?.(`router-model-discovery: ${service}: recorded as ${describeStatus(state)}`);
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
    this.previous.set(key, { service, status: state.status, configuration: state.configuration, reason: state.reason,
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
    // The adapter names the model its request was for, which is the service a
    // hold applies to. Without one the evidence is about the router as a whole.
    const service = nonEmptyString(event.model) ? event.model : undefined;
    const key = failureKey(provider, event.model);
    if (code === "SERVICE_OFFLINE" || code === "MODEL_NOT_FOUND") {
      const configuration = /configuration "([^"]+)"/.exec(event.message ?? "")?.[1] ?? watch?.current?.configuration?.id ?? null;
      this.holds.set(key, code === "SERVICE_OFFLINE"
        ? { status: "offline", reason: "SERVICE_OFFLINE", configuration, revision, until: now + REQUEST_HOLD_MS }
        : { status: "unavailable", reason: "not offered by the router (MODEL_NOT_FOUND)", revision, until: now + REQUEST_HOLD_MS });
      if (code === "MODEL_NOT_FOUND") this.logger?.warn?.(`router-model-discovery: ${service ?? "a service"}: router answered MODEL_NOT_FOUND; the service ID may be stale`);
    } else if (code === "BACKEND_UNAVAILABLE") {
      const entry = this.failures.get(key);
      const failures = entry && now - entry.first < BACKEND_FAILURE_WINDOW_MS ? { first: entry.first, count: entry.count + 1 } : { first: now, count: 1 };
      this.failures.set(key, failures);
      if (failures.count >= BACKEND_FAILURE_THRESHOLD) {
        this.holds.set(key, { status: "unavailable", reason: "backend unavailable (BACKEND_UNAVAILABLE)", revision, until: now + REQUEST_HOLD_MS });
        this.failures.delete(key);
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
  const providers = resolveProviderList(config.providers);
  const configuredInterval = Number(config.pollIntervalMs);
  const pollIntervalMs = Number.isFinite(configuredInterval)
    ? Math.max(MIN_POLL_INTERVAL_MS, Math.trunc(configuredInterval))
    : DEFAULT_POLL_INTERVAL_MS;
  const clientName = routerClientName({ instance: config.clientInstance });
  // §3 names `trial` as the service an operator opts into; the setting lets a
  // deployment name another without a Harness release.
  const optInServices = Array.isArray(config.optInServices) && config.optInServices.length
    ? config.optInServices.filter(nonEmptyString) : [...OPT_IN_SERVICES];
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
      clientName, watchOptions: plainObject(config.watch) ? config.watch : {}, optInServices });
    sctx.effect(() => {
      discovery.start();
      return () => discovery.stop();
    }, "router model discovery synchronization");
  });
}
