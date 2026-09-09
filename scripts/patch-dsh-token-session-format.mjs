#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_TARGET = "/opt/dsh-seed/profiles/web/node_modules/@zoytown/dsh-token/lib/index.js";
const PATCH_MARKER = "dsh-token-session-format-v3-compat-v1";

function replaceOnce(source, before, after, description) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`cannot patch ${description}: expected source was not found`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`cannot patch ${description}: expected source was not unique`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

/** Decode the event-per-row physical shape used by released session format v3. */
export function decodeCurrentSessionRow(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("malformed format v3 session row: expected an object");
  }
  if (typeof value.type !== "string" || value.type.length === 0) {
    throw new Error("malformed format v3 session row: type must be a non-empty string");
  }
  if (!Number.isSafeInteger(value.seq) || value.seq < 0) {
    throw new Error("malformed format v3 session row: seq must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(value.time) || !Object.hasOwn(value, "data")) {
    throw new Error("malformed format v3 session row: time and data are required");
  }
  return value;
}

/** Return the exact inherited prefix cut encoded by format v3's seed marker. */
export function inheritedEventCount(events) {
  const marker = events.findLast((event) =>
    event.type === "session/end-seed" &&
    event.data !== null &&
    typeof event.data === "object" &&
    event.data.inherited === true,
  );
  return marker?.seq ?? 0;
}

/** Port dsh-token 0.1.3's raw session reader to the released v3 storage shape. */
export function patchSource(input) {
  if (input.includes(PATCH_MARKER)) return input;
  let source = replaceOnce(
    input,
    `import { SESSION_FORMAT_VERSION, decodeStorageRecord } from "@deepseek-ai/dsh-session";`,
    `import { SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";`,
    "removed dsh-session decoder import",
  );
  source = replaceOnce(
    source,
    `function decodeArtifactBytes(bytes, compressed, fromCursor = 0, cachedHeader) {`,
    `// ${PATCH_MARKER}: released v3 stores one physical event per JSONL row.\n${decodeCurrentSessionRow.toString()}\n${inheritedEventCount.toString()}\nfunction decodeArtifactBytes(bytes, compressed, fromCursor = 0, cachedHeader) {`,
    "format v3 compatibility helpers",
  );
  source = replaceOnce(
    source,
    `\tconst events = [];\n\tfor (const line of body) for (const event of decodeStorageRecord(JSON.parse(line))) events.push(event);`,
    `\tconst events = [];\n\tfor (const line of body) events.push(decodeCurrentSessionRow(JSON.parse(line)));\n\tif (fromCursor === 0) header = { ...header, seedLength: inheritedEventCount(events) };`,
    "format v3 row decoding",
  );
  return source;
}

async function main() {
  const target = process.argv[2] ?? DEFAULT_TARGET;
  const before = await readFile(target, "utf8");
  const after = patchSource(before);
  if (after !== before) await writeFile(target, after);
  if (!after.includes(PATCH_MARKER)) throw new Error("dsh-token session-format patch did not apply");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
