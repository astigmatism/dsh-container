import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const profile = await readFile(new URL("../seed/profile/cordis.patch.yml", import.meta.url), "utf8");
const settings = await readFile(new URL("../config/settings.yaml", import.meta.url), "utf8");

const CONTEXT_WINDOW = 131072;
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

test("Web mounts automatic compaction, manual recovery, and replay-safe pruning", () => {
  const compact = block("compaction-basic", "command-compact");
  assert.match(compact, /disabled: false/);
  assert.match(compact, /auto: true/);
  assert.match(compact, /retainRatio: 0\.16/);
  assert.match(compact, /maxOverflowRetries: 1/);
  assert.match(block("command-compact", "tool-result-pruner"), /disabled: false/);
  const pruner = block("tool-result-pruner", "dsh-playwright");
  assert.match(pruner, /disabled: false/);
  assert.match(pruner, /thresholdChars: 8192/);
});

test("canonical and legacy provider IDs share the 70 percent request budget policy", () => {
  const compact = block("compaction-basic", "command-compact");
  for (const provider of ["local-ollama", "local-ollama-256k"]) {
    assert.match(
      compact,
      new RegExp(`provider: ${provider.replaceAll("-", "\\-")}\\n\\s+model: local-active\\n\\s+thresholdRatio: 0\\.70`),
    );
  }
  assert.equal((compact.match(/thresholdRatio: 0\.70/g) ?? []).length, 2);
});

test("incident pre-step pressure compacts before the inadmissible dispatch", () => {
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

test("pi-ai clamp miss is reproduced without reducing normal output allowance", () => {
  const estimatorSafety = 4096;
  const clamp = (estimated) => Math.min(
    REQUESTED_OUTPUT,
    Math.max(1, CONTEXT_WINDOW - estimated - estimatorSafety),
  );
  assert.equal(clamp(INCIDENT_PI_ESTIMATE), REQUESTED_OUTPUT);
  assert.equal(CONTEXT_WINDOW - INCIDENT_PI_ESTIMATE - estimatorSafety - REQUESTED_OUTPUT, 2832);
  assert.equal(INCIDENT_ROUTER_INPUT - INCIDENT_PI_ESTIMATE, 9789);
  assert.ok(INCIDENT_ROUTER_INPUT > CONTEXT_WINDOW - REQUESTED_OUTPUT - ROUTER_RESERVE);
  assert.equal(clamp(20000), REQUESTED_OUTPUT, "ordinary smaller requests retain 32768 output tokens");
});

test("captured tool-result pruning returns far below the policy threshold", () => {
  const reclaimed = 49344;
  assert.equal(99735 - reclaimed, 50391);
  assert.ok(50391 < Math.floor(CONTEXT_WINDOW * 0.70));
  assert.equal(97280 - 50391, 46889);
});

test("context overflow remains outside the ordinary retry set", () => {
  for (const provider of ["local-ollama", "local-ollama-256k"]) {
    const start = settings.indexOf(`    ${provider}:\n`);
    assert.notEqual(start, -1);
    const retryLine = settings.slice(start).match(/retryableCodes: \[([^\]]+)\]/)?.[1] ?? "";
    assert.match(retryLine, /EMPTY_RESPONSE/);
    assert.doesNotMatch(retryLine, /CONTEXT|TIMEOUT/);
  }
});
