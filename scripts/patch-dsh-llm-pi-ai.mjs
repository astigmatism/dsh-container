#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_TARGET = "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js";
const PATCH_MARKER = "dsh-router-contract-v3";
const DEFAULT_CONTEXT_CLASSIFIER_TARGETS = [
  "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js",
  "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/error.js",
];
const CONTEXT_CLASSIFIER_PATCH_MARKER = "dsh-router-context-overflow-v1";

function replaceOnce(source, before, after, description) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`cannot patch ${description}: expected source was not found`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`cannot patch ${description}: expected source was not unique`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

/** Make structured provider failures safe for every Harness display boundary. */
export function renderStructuredError(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error && value.message.length > 0) return value.message;
  if (value !== null && typeof value === "object") {
    const nested = value.error;
    const message =
      (typeof value.message === "string" && value.message.length > 0 ? value.message : undefined) ??
      (nested !== null && typeof nested === "object" && typeof nested.message === "string" && nested.message.length > 0
        ? nested.message
        : undefined);
    const code =
      (typeof value.code === "string" && value.code.length > 0 ? value.code : undefined) ??
      (nested !== null && typeof nested === "object" && typeof nested.code === "string" && nested.code.length > 0
        ? nested.code
        : undefined);
    if (message !== undefined) return code === undefined ? message : `${code}: ${message}`;
    try {
      const encoded = JSON.stringify(value);
      if (encoded !== undefined && encoded !== "{}") return encoded;
    } catch {}
  }
  return String(value);
}

/** Router-specific structured and prose context-overflow forms. */
export function isRouterContextOverflowDetail(detail) {
  return /(?:^|[^a-z0-9])context[\s_-]limit[\s_-]exceed(?:ed|s)?(?:$|[^a-z0-9])/i.test(detail) ||
    /\b(?:formatted\s+)?(?:input|prompt|request|messages?)\b.{0,120}\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,120}\b\d[\d,]*[\s_-]*token[\s_-]+slot\b/i.test(detail);
}

/** Complete patched shared-classifier behavior, exposed for source tests. */
export function isContextWindowOverflowDetail(detail) {
  return isRouterContextOverflowDetail(detail) ||
    /(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-](?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])/i.test(detail) ||
    /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(detail) ||
    /\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?(?:model(?:'s)?\s+)?context(?:\s+window)?\b/i.test(detail) ||
    /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i.test(detail) ||
    /\b(?:input|prompt|request|messages?)\b.{0,40}\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b/i.test(detail);
}

/** Process-wide channel to the router-model-discovery plugin (docs/llm-router-contract.md §10). */
export const ROUTER_CONTRACT_HUB = Symbol.for("dsh-container.router-contract.v1");
const ROUTER_CONTRACT_CODES = new Set(["SERVICE_OFFLINE", "MODEL_NOT_FOUND", "BACKEND_UNAVAILABLE", "BACKEND_DRAINING", "MAINTENANCE_MODE"]);

/**
 * Read a router error code from a pi-ai assistant message. The patched pi-ai
 * transport records `routerError` from the SDK error object (`error.code`) or
 * from an in-stream `response.failed`/`error` event; the error text is only a
 * fallback for transports that do not.
 */
export function routerErrorOf(message, text) {
  const structured = message?.routerError;
  if (structured !== null && typeof structured === "object" && typeof structured.code === "string" && structured.code.length > 0) {
    return {
      code: structured.code,
      ...(Number.isInteger(structured.status) ? { status: structured.status } : {}),
      detail: typeof structured.message === "string" && structured.message.length > 0 ? structured.message : text,
    };
  }
  if (typeof text !== "string") return undefined;
  const http = /\bAPI error \((\d{3})\): (\{[\s\S]*\})\s*$/.exec(text);
  if (http) {
    try {
      const body = JSON.parse(http[2]);
      const error = body !== null && typeof body.error === "object" && body.error !== null ? body.error : body;
      if (typeof error?.code === "string" && error.code.length > 0) {
        return { code: error.code, status: Number(http[1]), detail: typeof error.message === "string" ? error.message : text };
      }
    } catch {}
  }
  const inStream = /^(?:Error Code )?([A-Z][A-Z0-9_]+): ([\s\S]*)$/.exec(text);
  if (inStream && ROUTER_CONTRACT_CODES.has(inStream[1])) return { code: inStream[1], detail: inStream[2] };
  return undefined;
}

/**
 * Classify a failed router request by `error.code` first, then HTTP status
 * (contract §10). Fallback is disabled by the owner (§5), so SERVICE_OFFLINE
 * and MODEL_NOT_FOUND end at once without consuming retries; draining and
 * maintenance wait (ROUTER_SWITCHING); BACKEND_UNAVAILABLE and other 5xx use
 * the provider's bounded retry policy. Undefined keeps the existing classifier.
 */
export function routerFailureOf(message, text) {
  const error = routerErrorOf(message, text);
  if (error === undefined) return undefined;
  try { globalThis[ROUTER_CONTRACT_HUB]?.report?.(message?.provider, { code: error.code, status: error.status, message: error.detail }); } catch {}
  const service = typeof message?.model === "string" ? message.model : "model";
  const label = { daytime: "Daytime", nighttime: "Nighttime" }[service] ?? JSON.stringify(service);
  const status = error.status === undefined ? {} : { status: error.status };
  const detail = typeof error.detail === "string" && error.detail.length > 0 && error.detail !== text ? ` Router: ${error.detail}` : "";
  switch (error.code) {
    case "SERVICE_OFFLINE":
      return { message: `${label} is offline in the router's current configuration (SERVICE_OFFLINE). Switch this session to another model; Harness makes ${label} selectable again automatically when it returns.${detail}`, code: "MODEL_UNAVAILABLE", ...status };
    case "MODEL_NOT_FOUND":
      return { message: `The router does not offer ${label} (MODEL_NOT_FOUND). Switch this session to another model.${detail}`, code: "MODEL_UNAVAILABLE", ...status };
    case "BACKEND_DRAINING":
    case "MAINTENANCE_MODE":
      return { message: `The router is switching configuration (${error.code}); Harness waits and retries ${label} without changing models.${detail}`, code: "ROUTER_SWITCHING", ...status };
    case "BACKEND_UNAVAILABLE":
      return { message: `The router reports that ${label}'s backend is unavailable (BACKEND_UNAVAILABLE).${detail}`, code: "SERVER", ...status };
    case "context_length_exceeded":
      return undefined;
  }
  if (error.status === undefined) return undefined;
  if (error.status === 408) return { message: text, code: "TRANSPORT", status: 408 };
  if (error.status === 429) return { message: text, code: "RATE_LIMIT", status: 429 };
  if (error.status >= 500) return { message: text, code: "SERVER", ...status };
  // Other 4xx: the request is invalid. Never retry or fall back.
  return { message: text, code: error.status === 401 || error.status === 403 ? "AUTH" : "INVALID_REQUEST", ...status };
}

/** Fetch wrapper whose marker lets the patched router transport report byte activity. */
export function routerActivityFetch(watchdog) {
  const activityFetch = (...args) => globalThis.fetch(...args);
  activityFetch.routerActivity = () => watchdog.pulse();
  return activityFetch;
}

/**
 * Fair generation gate used by the patched adapter. The endpoint and provider
 * together identify an operator-selected backend profile, allowing the 128K
 * and 256K routes to enforce their distinct capacities on the same URL.
 */
export class EndpointConcurrencyGate {
  constructor() {
    this.entries = new Map();
  }

  acquire(profile, signal) {
    const limit = profile.maxConcurrency;
    if (limit === undefined) return Promise.resolve(() => {});
    const endpoint = (profile.baseURL ?? profile.provider).replace(/\/+$/, "");
    const key = `${endpoint}\n${profile.provider}`;
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = { active: 0, limit, queue: [] };
      this.entries.set(key, entry);
    } else if (entry.limit !== limit) {
      entry.limit = limit;
      this.drain(entry);
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("model request cancelled while waiting for provider capacity"));
    }
    if (entry.active < entry.limit && entry.queue.length === 0) {
      entry.active += 1;
      return Promise.resolve(this.lease(entry));
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: undefined };
      waiter.onAbort = () => {
        const index = entry.queue.indexOf(waiter);
        if (index < 0) return;
        entry.queue.splice(index, 1);
        reject(signal.reason ?? new Error("model request cancelled while waiting for provider capacity"));
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      entry.queue.push(waiter);
    });
  }

  lease(entry) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.active -= 1;
      this.drain(entry);
    };
  }

  drain(entry) {
    while (entry.active < entry.limit && entry.queue.length > 0) {
      const waiter = entry.queue.shift();
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.signal.reason ?? new Error("model request cancelled while waiting for provider capacity"));
        continue;
      }
      entry.active += 1;
      waiter.resolve(this.lease(entry));
    }
  }
}

/** Apply the pinned dsh-llm-pi-ai source patch, failing loudly on drift. */
export function patchSource(input) {
  if (input.includes(PATCH_MARKER)) return input;
  let source = input;

  source = replaceOnce(
    source,
    `\t\tconst name = label(entry?.name, entry?.display_name, entry?.displayName) ?? id;\n\t\tconst contextWindow = capacity(entry?.contextWindow, entry?.context_window, entry?.context_length, entry?.max_input_tokens, entry?.limit?.context);\n\t\tconst maxTokens = capacity(entry?.maxOutputTokens, entry?.max_output_tokens, entry?.maxTokens, entry?.max_tokens, entry?.limit?.output, entry?.top_provider?.max_completion_tokens);`,
    `\t\t// ${PATCH_MARKER}: prefer the router's complete public schema over legacy listing fields.\n\t\tconst router = entry?.x_ollama_router?.schema_version === 2 && entry.x_ollama_router.complete === true\n\t\t\t? entry.x_ollama_router\n\t\t\t: void 0;\n\t\tconst name = label(entry?.name, entry?.display_name, entry?.displayName) ?? id;\n\t\tconst contextWindow = capacity(router?.context_window, entry?.contextWindow, entry?.context_window, entry?.context_length, entry?.max_input_tokens, entry?.limit?.context);\n\t\tconst maxTokens = capacity(router?.reasoning?.absolute_max_output_tokens, router?.max_output_tokens, entry?.maxOutputTokens, entry?.max_output_tokens, entry?.maxTokens, entry?.max_tokens, entry?.limit?.output, entry?.top_provider?.max_completion_tokens);`,
    "router discovery capacities",
  );

  source = replaceOnce(
    source,
    `\tstreamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),\n\tmaxRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),`,
    `\tstreamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),\n\tmaxConcurrency: z.number().step(1).min(1),\n\tmaxRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),`,
    "provider concurrency schema",
  );

  source = replaceOnce(
    source,
    `\t\tconst streamIdleTimeoutMs = source.streamIdleTimeoutMs ?? 3e5;\n\t\tif (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(\`llm-pi-ai: provider "\${provider}" streamIdleTimeoutMs must be a positive finite number no greater than \${MAX_TIMER_DELAY_MS}\`);\n\t\tconst maxRequestImageBytes = source.maxRequestImageBytes ?? 20971520;`,
    `\t\tconst streamIdleTimeoutMs = source.streamIdleTimeoutMs ?? 3e5;\n\t\tif (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(\`llm-pi-ai: provider "\${provider}" streamIdleTimeoutMs must be a positive finite number no greater than \${MAX_TIMER_DELAY_MS}\`);\n\t\tif (source.maxConcurrency !== void 0 && (!Number.isSafeInteger(source.maxConcurrency) || source.maxConcurrency < 1)) throw new Error(\`llm-pi-ai: provider "\${provider}" maxConcurrency must be a positive safe integer\`);\n\t\tconst maxRequestImageBytes = source.maxRequestImageBytes ?? 20971520;`,
    "provider concurrency validation",
  );

  source = replaceOnce(
    source,
    `function classifyPiAiError(message) {`,
    `const ROUTER_CONTRACT_HUB = Symbol.for("dsh-container.router-contract.v1");\nconst ROUTER_CONTRACT_CODES = new Set(${JSON.stringify([...ROUTER_CONTRACT_CODES])});\n${routerErrorOf.toString()}\n${routerFailureOf.toString()}\n${routerActivityFetch.toString()}\nfunction renderPiAiError(value) {\n\tif (typeof value === "string") return value;\n\tif (value instanceof Error && value.message.length > 0) return value.message;\n\tif (value !== null && typeof value === "object") {\n\t\tconst nested = value.error;\n\t\tconst message = (typeof value.message === "string" && value.message.length > 0 ? value.message : void 0) ?? (nested !== null && typeof nested === "object" && typeof nested.message === "string" && nested.message.length > 0 ? nested.message : void 0);\n\t\tconst code = (typeof value.code === "string" && value.code.length > 0 ? value.code : void 0) ?? (nested !== null && typeof nested === "object" && typeof nested.code === "string" && nested.code.length > 0 ? nested.code : void 0);\n\t\tif (message !== void 0) return code === void 0 ? message : \`\${code}: \${message}\`;\n\t\ttry {\n\t\t\tconst encoded = JSON.stringify(value);\n\t\t\tif (encoded !== void 0 && encoded !== "{}") return encoded;\n\t\t} catch {}\n\t}\n\treturn String(value);\n}\nfunction classifyPiAiError(message) {`,
    "structured pi-ai error rendering",
  );

  source = replaceOnce(
    source,
    `function mapStopReason(message, contextWindow) {\n\tconst piAiOverflow = isContextOverflow(message, contextWindow);\n\tconst harnessOverflow = message.stopReason === "error" && message.errorMessage !== void 0 && isContextWindowExceededError(message.errorMessage);`,
    `function mapStopReason(message, contextWindow) {\n\tconst errorText = message.errorMessage === void 0 ? void 0 : renderPiAiError(message.errorMessage);\n\tconst piAiOverflow = isContextOverflow(message, contextWindow);\n\tconst harnessOverflow = message.stopReason === "error" && errorText !== void 0 && isContextWindowExceededError(errorText);`,
    "normalized stop-reason input",
  );

  source = replaceOnce(
    source,
    `\t\t\tmessage: message.errorMessage ?? \`pi-ai detected context overflow for model "\${message.model}"\`,`,
    `\t\t\tmessage: errorText ?? \`pi-ai detected context overflow for model "\${message.model}"\`,`,
    "overflow error rendering",
  );

  source = replaceOnce(
    source,
    `\t\t\t\tmessage: message.errorMessage ?? "pi-ai stream aborted",`,
    `\t\t\t\tmessage: errorText ?? "pi-ai stream aborted",`,
    "aborted error rendering",
  );

  source = replaceOnce(
    source,
    `\t\tcase "error": {\n\t\t\tconst text = message.errorMessage ?? "pi-ai stream error";`,
    `\t\tcase "error": {\n\t\t\tconst text = errorText ?? "pi-ai stream error";\n\t\t\t// ${PATCH_MARKER}: router error.code first (docs/llm-router-contract.md §10).\n\t\t\tconst routed = routerFailureOf(message, text);\n\t\t\tif (routed !== void 0) return { kind: "error", failure: routed };`,
    "terminal error rendering",
  );

  source = replaceOnce(
    source,
    `\tswitch (message.stopReason) {`,
    `\tif (message.stopReason !== "error" && message.stopReason !== "aborted") try { globalThis[ROUTER_CONTRACT_HUB]?.success?.(message.provider); } catch {}\n\tswitch (message.stopReason) {`,
    "router success reporting",
  );

  source = replaceOnce(
    source,
    `var PiAiAdapter = class extends LlmAdapter {`,
    `${EndpointConcurrencyGate.toString()}\nvar PiAiAdapter = class extends LlmAdapter {`,
    "endpoint concurrency gate",
  );

  source = replaceOnce(
    source,
    `\tconfig;\n\tsnapshot;`,
    `\tconfig;\n\tsnapshot;\n\tconcurrency = new EndpointConcurrencyGate();`,
    "adapter concurrency state",
  );

  source = replaceOnce(
    source,
    `\t\t\tconst watchdog = __addDisposableResource(env_1, idleWatchdog(upstream, streamIdleTimeoutMs, "LLM_STREAM_IDLE_TIMEOUT"), false);\n\t\t\ttry {`,
    `\t\t\tconst watchdog = __addDisposableResource(env_1, idleWatchdog(upstream, streamIdleTimeoutMs, "LLM_STREAM_IDLE_TIMEOUT"), false);\n\t\t\tlet releaseConcurrency;\n\t\t\ttry {`,
    "concurrency lease declaration",
  );

  source = replaceOnce(
    source,
    `\t\t\t\t\tsignal: watchdog.signal,\n\t\t\t\t\theaders: requestHeaders(profile.headers)\n`,
    `\t\t\t\t\tsignal: watchdog.signal,\n\t\t\t\t\theaders: requestHeaders(profile.headers),\n\t\t\t\t\t// ${PATCH_MARKER}: router queue keepalives (SSE comments) count as stream activity.\n\t\t\t\t\t...model.api === "openai-responses" ? { fetch: routerActivityFetch(watchdog) } : {}\n`,
    "router stream activity",
  );

  source = replaceOnce(
    source,
    `\t\t\t\tconst iterator = toStreamChunks(snapshot.models.streamSimple(model, context, {`,
    `\t\t\t\treleaseConcurrency = await this.concurrency.acquire(profile, upstream);\n\t\t\t\tconst iterator = toStreamChunks(snapshot.models.streamSimple(model, context, {`,
    "generation concurrency acquisition",
  );

  source = replaceOnce(
    source,
    `\t\t\t} finally {\n\t\t\t\tconsumer.abort("pi-ai stream consumer stopped");\n\t\t\t}`,
    `\t\t\t} finally {\n\t\t\t\treleaseConcurrency?.();\n\t\t\t\tconsumer.abort("pi-ai stream consumer stopped");\n\t\t\t}`,
    "generation concurrency release",
  );

  return source;
}

/** Extend DSH's shared conservative overflow classifier for the local router. */
export function patchContextClassifierSource(input) {
  if (input.includes(CONTEXT_CLASSIFIER_PATCH_MARKER)) return input;
  let source = input;

  source = replaceOnce(
    source,
    `function isContextWindowExceededError(detail) {\n`,
    `// ${CONTEXT_CLASSIFIER_PATCH_MARKER}: normalize the local router's code and token-slot wording.\nfunction isRouterContextOverflowDetail(detail) {\n\treturn /(?:^|[^a-z0-9])context[\\s_-]limit[\\s_-]exceed(?:ed|s)?(?:$|[^a-z0-9])/i.test(detail) || /\\b(?:formatted\\s+)?(?:input|prompt|request|messages?)\\b.{0,120}\\b(?:exceed(?:s|ed)?|overflows?|is\\s+larger\\s+than)\\b.{0,120}\\b\\d[\\d,]*[\\s_-]*token[\\s_-]+slot\\b/i.test(detail);\n}\nfunction isContextWindowExceededError(detail) {\n`,
    "router context-overflow detail classifier",
  );

  source = replaceOnce(
    source,
    `return STRUCTURED_CONTEXT_OVERFLOW.test(detail)`,
    `return isRouterContextOverflowDetail(detail) || STRUCTURED_CONTEXT_OVERFLOW.test(detail)`,
    "shared context-overflow classification",
  );

  return source;
}

async function main() {
  const target = process.argv[2] ?? DEFAULT_TARGET;
  const before = await readFile(target, "utf8");
  const after = patchSource(before);
  if (after !== before) await writeFile(target, after);
  if (!after.includes(PATCH_MARKER)) throw new Error("dsh router contract patch did not apply");

  // A custom adapter fixture target is useful for local patch debugging. The
  // no-argument image-build path also patches both public/shared DSH outlets.
  if (process.argv[2] === undefined) {
    for (const classifierTarget of DEFAULT_CONTEXT_CLASSIFIER_TARGETS) {
      const classifierBefore = await readFile(classifierTarget, "utf8");
      const classifierAfter = patchContextClassifierSource(classifierBefore);
      if (classifierAfter !== classifierBefore) await writeFile(classifierTarget, classifierAfter);
      if (!classifierAfter.includes(CONTEXT_CLASSIFIER_PATCH_MARKER)) {
        throw new Error(`dsh context-overflow classifier patch did not apply: ${classifierTarget}`);
      }
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
