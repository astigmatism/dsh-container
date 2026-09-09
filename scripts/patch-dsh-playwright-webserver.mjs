#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_TARGET = "/opt/dsh-seed/profiles/web/node_modules/dsh-playwright/lib/index.js";
const PATCH_MARKER = "dsh-playwright-webserver-scope-v1";

function replaceOnce(source, before, after, description) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`cannot patch ${description}: expected source was not found`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`cannot patch ${description}: expected source was not unique`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

/** Mount HTTP-backed Browser Use routes only inside the current webServer scope. */
export function patchSource(input) {
  if (input.includes(PATCH_MARKER)) return input;
  let source = replaceOnce(
    input,
    `\tregisterStreamRoute(ctx, browser);`,
    `\t// ${PATCH_MARKER}: newer Harness exposes webServer through a scoped injection.\n\tctx.inject(["webServer"], (webCtx) => {\n\t\tregisterStreamRoute(webCtx, browser);`,
    "screencast route webServer scope",
  );
  source = replaceOnce(
    source,
    `\tctx.connection.rpc.handle(RPC_CHANNEL, async (endpoint, payload, signal) => {`,
    `\t\twebCtx.connection.rpc.handle(RPC_CHANNEL, async (endpoint, payload, signal) => {`,
    "browser RPC webServer scope",
  );
  source = replaceOnce(
    source,
    `\t}, { authority: "loopback" });\n}`,
    `\t\t}, { authority: "loopback" });\n\t});\n}`,
    "browser RPC scope closure",
  );
  return source;
}

async function main() {
  const target = process.argv[2] ?? DEFAULT_TARGET;
  const before = await readFile(target, "utf8");
  const after = patchSource(before);
  if (after !== before) await writeFile(target, after);
  if (!after.includes(PATCH_MARKER)) throw new Error("dsh-playwright webServer-scope patch did not apply");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
