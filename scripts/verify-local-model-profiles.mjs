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
    displayName: "Daytime (128K)",
    modelName: "Daytime (128K)",
    contextWindow: 131072,
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
  // Contract §3: send stable service IDs only; never persist canonical IDs.
  const service = profile.provider === "local-everyday" ? "nighttime" : "daytime";
  assert.ok(block.includes(`- id: ${service}\n`), `${profile.provider} must send the router service ID ${service}`);
  assert.ok(!/- id: (?!daytime\n|nighttime\n)/.test(block), `${profile.provider} configures a non-service model ID`);
  assert.ok(block.includes(`name: ${profile.modelName}`), `${profile.provider} has the wrong model name`);
  assert.ok(block.includes(`contextWindow: ${profile.contextWindow}`), `${profile.provider} has the wrong context window`);
  assert.ok(block.includes(`maxConcurrency: ${profile.maxConcurrency}`), `${profile.provider} has the wrong concurrency`);
  assert.ok(block.includes("reasoning: medium"), `${profile.provider} is missing the deliberate medium seed`);
  assert.ok(block.includes("maxTokens: null"), `${profile.provider} invents an output allowance`);
  assert.ok(!/^      timeoutMs:/m.test(block), `${profile.provider} sets a generation deadline`);
}

assert.match(settings, /^agent-default-model:\n(?:#.*\n)?  provider: local-ollama\n  model: daytime\n/m, "the seeded default must use the daytime service ID");
console.log("Verified seeded Daytime and Nighttime placeholders: service IDs only, unrestricted output and an explicit DSH medium default.");
