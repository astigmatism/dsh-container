#!/usr/bin/env node

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

export function loaderRow(effective, id) {
  const lines = effective.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- id: ${id}`);
  assert.notEqual(start, -1, `effective Web composition is missing ${id}`);
  const indent = lines[start].match(/^\s*/)?.[0] ?? "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line?.startsWith(`${indent}- `)) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

export function verifyTokenPolicy(effective, expected) {
  assert.ok(expected === "enabled" || expected === "disabled", `invalid expected policy: ${expected}`);
  const token = loaderRow(effective, "dsh-token");
  const serialized = token.match(/^\s*disabled:\s*(.+?)\s*$/m)?.[1];
  assert.ok(serialized, `dsh-token has no disabled policy; effective row:\n${token}`);
  let disabled;
  if (serialized === "true" || serialized === "false") {
    disabled = serialized === "true";
  } else {
    const expression = serialized.replace(/^!!js\s+/, "");
    const policyProcess = {
      env: expected === "enabled" ? { DSH_TOKEN_ENABLED: "true" } : {},
    };
    disabled = Function("process", `return (${expression});`)(policyProcess);
  }
  assert.equal(typeof disabled, "boolean", "dsh-token disabled policy must evaluate to a Boolean");
  if (expected === "disabled") {
    assert.equal(disabled, true, `dsh-token must be disabled by default; effective row:\n${token}`);
  } else {
    assert.equal(disabled, false, `DSH_TOKEN_ENABLED=true must explicitly enable dsh-token; effective row:\n${token}`);
  }
  return token;
}

async function main() {
  const [mode, expected] = process.argv.slice(2);
  if (mode !== "--effective-config" || !expected) {
    throw new Error("usage: verify-dsh-token-policy.mjs --effective-config enabled|disabled");
  }
  let effective = "";
  for await (const chunk of process.stdin) effective += chunk;
  verifyTokenPolicy(effective, expected);
  console.log(`Verified dsh-token is ${expected} in the effective Web composition.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
