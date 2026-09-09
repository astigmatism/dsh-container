#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const path = process.argv[2] ?? "/data/dsh/settings.yaml";
const settings = await readFile(path, "utf8");

function providerBlock(name, nextName) {
  const start = settings.indexOf(`    ${name}:\n`);
  assert.notEqual(start, -1, `missing provider ${name}`);
  const end = nextName === undefined ? settings.length : settings.indexOf(`    ${nextName}:\n`, start + 1);
  assert.notEqual(end, -1, `missing following provider ${nextName}`);
  return settings.slice(start, end);
}

const profiles = [
  {
    provider: "local-ollama",
    next: "local-ollama-256k",
    displayName: "Local Router (128K context)",
    modelName: "Local Active Model (128K context)",
    contextWindow: 131072,
    maxConcurrency: 2,
  },
  {
    provider: "local-ollama-256k",
    displayName: "Local Router (256K context)",
    modelName: "Local Active Model (256K context)",
    contextWindow: 262144,
    maxConcurrency: 1,
  },
];

for (const profile of profiles) {
  const block = providerBlock(profile.provider, profile.next);
  assert.ok(block.includes(`displayName: ${profile.displayName}`), `${profile.provider} has the wrong display name`);
  assert.ok(block.includes("- id: local-active"), `${profile.provider} is missing local-active`);
  assert.ok(block.includes(`name: ${profile.modelName}`), `${profile.provider} has the wrong model name`);
  assert.ok(block.includes(`contextWindow: ${profile.contextWindow}`), `${profile.provider} has the wrong context window`);
  assert.ok(block.includes(`maxConcurrency: ${profile.maxConcurrency}`), `${profile.provider} has the wrong concurrency`);
  assert.ok(block.includes("reasoning: medium"), `${profile.provider} does not default to medium reasoning`);
}

console.log("Verified selectable 128K/2 and 256K/1 local model profiles with medium reasoning defaults.");
