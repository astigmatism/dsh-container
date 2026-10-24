import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const profile = await readFile(new URL("../seed/profile/managed/cordis.patch.yml", import.meta.url), "utf8");
const settings = await readFile(new URL("../config/settings.yaml", import.meta.url), "utf8");

const CONTEXT_WINDOW = 131072;
/** The seeded placeholder budget of the router route, before any discovery. */
const PLACEHOLDER_CONTEXT_WINDOW = 131072;
const REQUESTED_OUTPUT = 32768;
const ROUTER_RESERVE = 1024;
const INCIDENT_ROUTER_INPUT = 101165;
const INCIDENT_PI_ESTIMATE = 91376;
const LAST_PROVIDER_INPUT = 91651;
const LAST_PROVIDER_OUTPUT = 115;
const FINAL_TOOL_RESULT_TOKENS = [5067, 2902];

function block(id, nextId) {
  const start = profile.indexOf(`- id: ${id}\n`);
  assert.notEqual(start, -1, `missing profile row ${id}`);
  const end = nextId === undefined ? profile.length : profile.indexOf(`- id: ${nextId}\n`, start + 1);
  assert.notEqual(end, -1, `missing following profile row ${nextId}`);
  return profile.slice(start, end);
}

test("Host keeps preset policy templates without mounting duplicate compaction services", () => {
  const compact = block("compaction-basic", "command-compact");
  assert.match(compact, /disabled: true/);
  assert.match(compact, /auto: true/);
  assert.match(compact, /retainRatio: 0\.16/);
  assert.match(compact, /maxOverflowRetries: 1/);
  assert.match(block("command-compact", "tool-result-pruner"), /disabled: true/);
  const pruner = block("tool-result-pruner", "ego-browser");
  assert.match(pruner, /disabled: true/);
  assert.match(pruner, /thresholdChars: 8192/);
});

test("every model of the router route compacts on the 70 percent request budget", () => {
  const compact = block("compaction-basic", "command-compact");
  // A router route serves whatever models its router publishes, so the seeded
  // threshold is the route default: every model the catalog adds, including an
  // opt-in service a human selects, compacts on the same budget, and no model is
  // seeded with a policy of its own.
  assert.match(compact, /thresholdRatio: 0\.70/);
  assert.equal((compact.match(/thresholdRatio: 0\.70/g) ?? []).length, 1);
  assert.doesNotMatch(compact, /modelPolicies|provider:|model: /, "a policy that names one model pins a catalog entry the seed cannot know");
});

test("the seed follows one router route, which is the route the budget covers", () => {
  // Discovery writes the model list of the route it is given, so a policy that
  // covers the route covers every model it will ever list.
  assert.match(profile, /- id: router-model-discovery[\s\S]{0,400}?providers: \[ local-ollama \]/);
  assert.match(profile, /optInServices: \[ trial \]/, "the opt-in service is named as a service, and stays opt-in");
  assert.doesNotMatch(profile, /local-everyday|local-trial/, "a service is never seeded as a route of its own");
});

test("a 128K service compacts on its working context without a summary quota", () => {
  assert.equal(Math.floor(PLACEHOLDER_CONTEXT_WINDOW * 0.70), 91750);
  assert.match(block("compaction-basic", "command-compact"), /maxTokens: null/);
});

test("historical incident pre-step pressure compacts before the inadmissible dispatch", () => {
  const defaultThreshold = Math.floor(CONTEXT_WINDOW * 0.8);
  const policyThreshold = Math.floor(CONTEXT_WINDOW * 0.70);
  const admissibleInput = CONTEXT_WINDOW - REQUESTED_OUTPUT - ROUTER_RESERVE;
  const dshPreStep = LAST_PROVIDER_INPUT + LAST_PROVIDER_OUTPUT + FINAL_TOOL_RESULT_TOKENS.reduce((a, b) => a + b, 0);

  assert.equal(defaultThreshold, 104857);
  assert.equal(policyThreshold, 91750);
  assert.equal(admissibleInput, 97280);
  assert.equal(dshPreStep, 99735);
  assert.ok(dshPreStep < defaultThreshold, "the old 80% trigger misses the incident");
  assert.ok(dshPreStep >= policyThreshold, "the route policy triggers at agent/pre-step");
  assert.ok(policyThreshold < admissibleInput);
  assert.equal(admissibleInput - policyThreshold, 5530);
  assert.equal(INCIDENT_ROUTER_INPUT - dshPreStep, 1430, "observed meter-to-router uncertainty");
});

test("historical capped pi-ai clamp miss remains reproducible", () => {
  const estimatorSafety = 4096;
  const clamp = (estimated) => Math.min(
    REQUESTED_OUTPUT,
    Math.max(1, CONTEXT_WINDOW - estimated - estimatorSafety),
  );
  assert.equal(clamp(INCIDENT_PI_ESTIMATE), REQUESTED_OUTPUT);
  assert.equal(CONTEXT_WINDOW - INCIDENT_PI_ESTIMATE - estimatorSafety - REQUESTED_OUTPUT, 2832);
  assert.equal(INCIDENT_ROUTER_INPUT - INCIDENT_PI_ESTIMATE, 9789);
  assert.ok(INCIDENT_ROUTER_INPUT > CONTEXT_WINDOW - REQUESTED_OUTPUT - ROUTER_RESERVE);
  assert.equal(clamp(20000), REQUESTED_OUTPUT, "historical smaller requests retained the inherited quota");
});

test("captured tool-result pruning returns far below the policy threshold", () => {
  const reclaimed = 49344;
  assert.equal(99735 - reclaimed, 50391);
  assert.ok(50391 < Math.floor(CONTEXT_WINDOW * 0.70));
  assert.equal(97280 - 50391, 46889);
});

test("context overflow remains outside the ordinary retry set", () => {
  const start = settings.indexOf("    local-ollama:\n");
  assert.notEqual(start, -1);
  const retryLine = settings.slice(start).match(/retryableCodes: \[([^\]]+)\]/)?.[1] ?? "";
  assert.match(retryLine, /EMPTY_RESPONSE/);
  assert.doesNotMatch(retryLine, /CONTEXT|TIMEOUT/);
});
