#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_TARGET = "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js";
const PATCH_MARKER = "dsh-router-contract-v2";

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

/**
 * Fair endpoint-level generation gate used by the patched adapter. Provider
 * compatibility aliases sharing one base URL therefore share one pool.
 */
export class EndpointConcurrencyGate {
  constructor() {
    this.entries = new Map();
  }

  acquire(profile, signal) {
    const limit = profile.maxConcurrency;
    if (limit === undefined) return Promise.resolve(() => {});
    const key = (profile.baseURL ?? profile.provider).replace(/\/+$/, "");
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = { active: 0, limit, queue: [] };
      this.entries.set(key, entry);
    } else {
      // Multiple compatibility provider IDs can name one endpoint. The most
      // conservative declared limit wins for the lifetime of this adapter.
      entry.limit = Math.min(entry.limit, limit);
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
    `\t\tconst name = label(entry?.name, entry?.display_name);\n\t\tconst contextWindow = capacity(entry?.context_window, entry?.context_length);\n\t\tconst maxTokens = capacity(entry?.max_output_tokens, entry?.max_tokens);`,
    `\t\t// ${PATCH_MARKER}: prefer the router's complete public schema over legacy listing fields.\n\t\tconst router = entry?.x_ollama_router?.schema_version === 2 && entry.x_ollama_router.complete === true\n\t\t\t? entry.x_ollama_router\n\t\t\t: void 0;\n\t\tconst name = label(entry?.name, entry?.display_name);\n\t\tconst contextWindow = capacity(router?.context_window, entry?.context_window, entry?.context_length);\n\t\tconst maxTokens = capacity(router?.reasoning?.absolute_max_output_tokens, router?.max_output_tokens, entry?.max_output_tokens, entry?.max_tokens);`,
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
    `function renderPiAiError(value) {\n\tif (typeof value === "string") return value;\n\tif (value instanceof Error && value.message.length > 0) return value.message;\n\tif (value !== null && typeof value === "object") {\n\t\tconst nested = value.error;\n\t\tconst message = (typeof value.message === "string" && value.message.length > 0 ? value.message : void 0) ?? (nested !== null && typeof nested === "object" && typeof nested.message === "string" && nested.message.length > 0 ? nested.message : void 0);\n\t\tconst code = (typeof value.code === "string" && value.code.length > 0 ? value.code : void 0) ?? (nested !== null && typeof nested === "object" && typeof nested.code === "string" && nested.code.length > 0 ? nested.code : void 0);\n\t\tif (message !== void 0) return code === void 0 ? message : \`\${code}: \${message}\`;\n\t\ttry {\n\t\t\tconst encoded = JSON.stringify(value);\n\t\t\tif (encoded !== void 0 && encoded !== "{}") return encoded;\n\t\t} catch {}\n\t}\n\treturn String(value);\n}\nfunction classifyPiAiError(message) {`,
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
    `\t\tcase "error": {\n\t\t\tconst text = errorText ?? "pi-ai stream error";`,
    "terminal error rendering",
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

async function main() {
  const target = process.argv[2] ?? DEFAULT_TARGET;
  const before = await readFile(target, "utf8");
  const after = patchSource(before);
  if (after !== before) await writeFile(target, after);
  if (!after.includes(PATCH_MARKER)) throw new Error("dsh router contract patch did not apply");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
