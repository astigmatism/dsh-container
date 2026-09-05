#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_TARGET = "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js";
const PATCH_MARKER = "dsh-router-contract-v1";

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
    `function classifyPiAiError(message) {`,
    `function renderPiAiError(value) {\n\tif (typeof value === "string") return value;\n\tif (value instanceof Error && value.message.length > 0) return value.message;\n\tif (value !== null && typeof value === "object") {\n\t\tconst nested = value.error;\n\t\tconst message = (typeof value.message === "string" && value.message.length > 0 ? value.message : void 0) ?? (nested !== null && typeof nested === "object" && typeof nested.message === "string" && nested.message.length > 0 ? nested.message : void 0);\n\t\tconst code = (typeof value.code === "string" && value.code.length > 0 ? value.code : void 0) ?? (nested !== null && typeof nested === "object" && typeof nested.code === "string" && nested.code.length > 0 ? nested.code : void 0);\n\t\tif (message !== void 0) return code === void 0 ? message : \`\${code}: \${message}\`;\n\t\ttry {\n\t\t\tconst encoded = JSON.stringify(value);\n\t\t\tif (encoded !== void 0 && encoded !== "{}") return encoded;\n\t\t} catch {}\n\t}\n\treturn String(value);\n}\n+function classifyPiAiError(message) {`,
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
