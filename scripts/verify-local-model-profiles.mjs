#!/usr/bin/env node

// Captured seed defaults only; runtime verification uses verify-router-contract.mjs.
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
    next: "local-everyday",
    displayName: "Daytime (160K)",
    modelName: "Daytime (160K)",
    contextWindow: 163840,
    maxConcurrency: 1,
  },
  {
    provider: "local-everyday",
    displayName: "Nighttime (128K)",
    modelName: "Nighttime (128K)",
    contextWindow: 131072,
    maxConcurrency: 1,
  },
];

for (const profile of profiles) {
  const block = providerBlock(profile.provider, profile.next);
  assert.ok(block.includes(`displayName: ${profile.displayName}`), `${profile.provider} has the wrong display name`);
  assert.ok(block.includes(`- id: ${profile.provider === "local-everyday" ? "qwen3.8-27b-abliterated-q6_k" : "local-active"}`), `${profile.provider} is missing local-active`);
  assert.ok(block.includes(`name: ${profile.modelName}`), `${profile.provider} has the wrong model name`);
  assert.ok(block.includes(`contextWindow: ${profile.contextWindow}`), `${profile.provider} has the wrong context window`);
  assert.ok(block.includes(`maxConcurrency: ${profile.maxConcurrency}`), `${profile.provider} has the wrong concurrency`);
  assert.ok(block.includes("reasoning: medium"), `${profile.provider} is missing the deliberate medium seed`);
  assert.ok(block.includes("maxTokens: null"), `${profile.provider} invents an output allowance`);
  assert.ok(!/^      timeoutMs:/m.test(block), `${profile.provider} sets a generation deadline`);
}

console.log("Verified resident coding 160K/1 and everyday 128K/1 model choices with unrestricted output and an explicit DSH medium default.");
