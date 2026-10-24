#!/usr/bin/env node

// Captured seed defaults only; runtime verification uses verify-router-contract.mjs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const path = process.argv[2] ?? "/data/dsh/settings.yaml";
const settings = await readFile(path, "utf8");

// One route per router, and that route's model list is the catalog its router
// publishes: discovery writes one row per service ID, titled with the router's
// own names. The seed therefore carries only the placeholder the seeded default
// names, and every number in it stands in until the first document answers.
const providersAt = settings.indexOf("llm-pi-ai:\n  providers:\n");
assert.notEqual(providersAt, -1, "the seed has no provider map");
const providers = settings.slice(providersAt);
const routes = [...providers.matchAll(/^    ([\w-]+):$/gm)].map(([, name]) => name);
assert.deepEqual(routes, ["local-ollama"], "the seed writes one route, to this deployment's router");

function routeBlock(name) {
  const start = providers.indexOf(`    ${name}:\n`);
  assert.notEqual(start, -1, `missing provider ${name}`);
  const rest = providers.slice(start + 1);
  const next = rest.search(/^ {4}[\w-]+:$/m);
  return next === -1 ? providers.slice(start) : providers.slice(start, start + 1 + next);
}
const route = routeBlock("local-ollama");

// Contract §3: send stable service IDs only; never persist a canonical ID. A row
// is titled by its service ID because the title a person chooses between is the
// router's, not this seed's, and a name written here would outlive the model
// that earned it.
assert.match(route, /- id: daytime\n/, "the placeholder row must send the router service ID daytime");
assert.doesNotMatch(route, /- id: (?!daytime\n)/, "the seed writes no model row beyond the placeholder");
assert.doesNotMatch(settings, /local-active|qwen3\.8/, "a canonical model ID is seeded");
assert.match(route, /- id: daytime\n\s+name: daytime\n/, "a placeholder row is titled by its service ID");
assert.doesNotMatch(route, /displayName: .*(?:Daytime|Nighttime|Trial)/, "a route is named for its router, not for a model");
assert.doesNotMatch(route, /name: .*(?:Daytime|Nighttime|Trial)/, "a model row is titled by the router, not by this seed");

assert.match(route, /api: openai-responses/, "the router route speaks the router's own protocol");
assert.match(route, /baseURL: http:\/\/ai-router:11434\/v1/, "the router route addresses this deployment's router");
assert.match(route, /apiKeyEnv: OLLAMA_DSH_API_KEY/);
assert.match(route, /contextWindow: 131072/, "the seed carries a placeholder context budget");
assert.match(route, /maxConcurrency: 1/, "the seed carries a placeholder concurrency");
assert.match(route, /maxTokens: null/, "the seed invents an output allowance");
assert.match(route, /reasoning: medium/, "the seed is missing the deliberate medium default");
assert.match(route, /off: none/);
assert.match(route, /high: xhigh/);
assert.match(route, /max: xhigh/);
assert.match(route, /streamIdleTimeoutMs: 900000/);
assert.doesNotMatch(route, /^      timeoutMs:/m, "the seed sets a generation deadline");
assert.match(route, /maxRetries: 2/);
assert.match(route, /retryableCodes: \[\s*EMPTY_RESPONSE, RATE_LIMIT, SERVER, TRANSPORT\s*\]/);
assert.doesNotMatch(route.match(/retryableCodes: \[([^\]]+)\]/)?.[1] ?? "", /TIMEOUT|CONTEXT_WINDOW_EXCEEDED/);

assert.match(settings, /^agent-default-model:\n(?:#.*\n)?  provider: local-ollama\n  model: daytime\n/m, "the seeded default must use the daytime service ID");
// The opt-in service is offered by discovery and reached only through a human
// selection, so no seed, restore or router-offline state may name it as the
// default — and no service the router offers is seeded as a route of its own.
const defaultBlock = settings.match(/^agent-default-model:\n((?:[ \t]+.*\n)*)/m)?.[1] ?? "";
assert.match(defaultBlock, /provider: local-ollama/, "the seeded default block was not found");
assert.doesNotMatch(defaultBlock, /trial/i, "the seeded default must not select the opt-in trial service");
assert.doesNotMatch(settings, /- id: trial\n|local-everyday|local-trial/, "a service the router offers is seeded as a route of its own");
console.log("Verified the seeded router route: one route, service IDs only, placeholder limits, unrestricted output and an explicit DSH medium default.");
