import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const settings = await readFile(new URL("../config/settings.yaml", import.meta.url), "utf8");
/** The provider map: one route per router, its model list written by discovery. */
const providersAt = settings.indexOf("llm-pi-ai:\n  providers:\n");
assert.notEqual(providersAt, -1, "the seed has no provider map");
const providers = settings.slice(providersAt);
const routeNames = [...providers.matchAll(/^    ([\w-]+):$/gm)].map(match => match[1]);
const routeBlock = (name) => {
  const start = providers.indexOf(`    ${name}:\n`);
  assert.notEqual(start, -1, `missing provider route ${name}`);
  const rest = providers.slice(start + 1);
  const next = rest.search(/^ {4}[\w-]+:$/m);
  return next === -1 ? providers.slice(start) : providers.slice(start, start + 1 + next);
};
const route = routeBlock("local-ollama");
const defaultSelection = settings.match(/^agent-default-model:\n((?:[ \t]+.*\n)*)/m)?.[1] ?? "";

test("the seeded selection names a router service and the deliberate DSH medium default", () => {
  assert.match(settings, /^agent-default-model:\n  provider: local-ollama\n  model: daytime\n  reasoningEffort: medium\n\n/m);
  assert.match(settings.slice(0, settings.indexOf("\npermission:")), /reasoningEffort: medium/);
  // Contract §3: a selection names the stable service ID. Canonical IDs change
  // with the router's configuration and are never configured.
  assert.equal((settings.match(/- id: \S+/g) ?? []).length, 1, "the seed writes no model row beyond the placeholder the default names");
  assert.match(route, /- id: daytime\n/);
  assert.doesNotMatch(settings, /local-active|qwen3\.8|- id: (?!daytime\n)/);
  // The opt-in service is offered by discovery, so no seed, restore or
  // offline-router state can start a session on it.
  assert.match(defaultSelection, /provider: local-ollama/);
  assert.doesNotMatch(defaultSelection, /trial/i);
  assert.doesNotMatch(settings, /- id: trial\n/, "the opt-in service is not seeded as a model row");
});

test("one route per router, with no model name of the deployment's own", () => {
  assert.deepEqual(routeNames, ["local-ollama"], "the seed writes one route, and discovery writes its models");
  // A route is named for what it is — the router renames it with the name the
  // router publishes for itself — and a placeholder row is titled by its service
  // ID, because the title a person sees is the router's, not this file's.
  assert.match(route, /displayName: Local router/);
  assert.doesNotMatch(route, /displayName: .*(?:Daytime|Nighttime|Trial)/);
  assert.match(route, /- id: daytime\n\s+name: daytime\n/);
  assert.doesNotMatch(route, /name: .*(?:Daytime|Nighttime|Trial)/);
  // Limits are placeholders until the first successful discovery replaces them
  // with the serving model's published numbers.
  assert.match(route, /contextWindow: 131072/);
  assert.match(route, /maxConcurrency: 1/);
  assert.match(route, /input: \[text, image\]/);
});

test("the router route carries one request contract", () => {
  assert.match(route, /apiKeyEnv: OLLAMA_DSH_API_KEY/);
  assert.match(route, /baseURL: http:\/\/ai-router:11434\/v1/);
  assert.match(route, /maxTokens: null/, "the seed invents no output allowance");
  assert.match(route, /reasoning: medium/);
  assert.match(route, /off: none/);
  assert.match(route, /minimal: low/);
  assert.match(route, /high: xhigh/);
  assert.match(route, /max: xhigh/);
  assert.match(route, /cacheRetention: none/);
});

test("busy retries stay bounded while context and timeout failures are not blindly retried", () => {
  assert.doesNotMatch(route, /^      timeoutMs:/m, "the seed sets no generation deadline");
  assert.match(route, /streamIdleTimeoutMs: 900000/);
  assert.match(route, /maxRetries: 2/);
  assert.match(route, /retryableCodes: \[\s*EMPTY_RESPONSE, RATE_LIMIT, SERVER, TRANSPORT\s*\]/);
  const retryable = route.match(/retryableCodes: \[([^\]]+)\]/)?.[1] ?? "";
  assert.doesNotMatch(retryable, /TIMEOUT|CONTEXT_WINDOW_EXCEEDED/);
});
