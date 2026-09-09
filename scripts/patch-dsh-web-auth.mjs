#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_TARGET = "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js";
const PATCH_MARKER = "dsh-container-web-launch-token-v1";

function replaceOnce(source, before, after, description) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`cannot patch ${description}: expected source was not found`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`cannot patch ${description}: expected source was not unique`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

/** Let the container entrypoint provide a fresh, file-shared launch token. */
export function patchSource(input) {
  if (input.includes(PATCH_MARKER)) return input;
  return replaceOnce(
    input,
    `function processLaunchToken(owner) {
\tconst existing = PROCESS_LAUNCH_TOKENS.get(owner);
\tif (existing !== void 0) return existing;
\tconst created = encodeBase64Url(randomBytes(SECRET_BYTES));
\tPROCESS_LAUNCH_TOKENS.set(owner, created);
\treturn created;
}`,
    `function processLaunchToken(owner) {
\tconst existing = PROCESS_LAUNCH_TOKENS.get(owner);
\tif (existing !== void 0) return existing;
\t// ${PATCH_MARKER}: share only the one-time launch token with the colocated gateway.
\tconst configured = process.env.DSH_WEB_LAUNCH_TOKEN;
\tif (configured !== void 0) {
\t\tif (canonicalSecret(configured) === void 0) throw new Error("client-connection: DSH_WEB_LAUNCH_TOKEN must be 32-byte base64url");
\t\tPROCESS_LAUNCH_TOKENS.set(owner, configured);
\t\treturn configured;
\t}
\tconst created = encodeBase64Url(randomBytes(SECRET_BYTES));
\tPROCESS_LAUNCH_TOKENS.set(owner, created);
\treturn created;
}`,
    "browser launch-token source",
  );
}

async function main() {
  const target = process.argv[2] ?? DEFAULT_TARGET;
  const before = await readFile(target, "utf8");
  const after = patchSource(before);
  if (after !== before) await writeFile(target, after);
  if (!after.includes(PATCH_MARKER)) throw new Error("DSH web-auth patch did not apply");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
