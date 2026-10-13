import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const settings = await readFile(new URL("../config/settings.yaml", import.meta.url), "utf8");

function providerBlock(name, nextName) {
  const start = settings.indexOf("    " + name + ":\n");
  assert.notEqual(start, -1, "missing provider " + name);
  const end = nextName === undefined ? settings.length : settings.indexOf("    " + nextName + ":\n", start + 1);
  assert.notEqual(end, -1, "missing following provider " + nextName);
  return settings.slice(start, end);
}

const canonical = providerBlock("local-ollama", "local-everyday");
const expanded = providerBlock("local-everyday", "local-trial");
const optIn = providerBlock("local-trial");

test("seeded selections send only router service IDs and the deliberate DSH medium default", () => {
  assert.match(settings, /^agent-default-model:\n  provider: local-ollama\n  model: daytime\n  reasoningEffort: medium\n\n/m);
  assert.match(settings.slice(0, settings.indexOf("\npermission:")), /reasoningEffort: medium/);
  assert.equal((settings.match(/- id: daytime\n/g) ?? []).length, 1);
  assert.match(expanded, /- id: nighttime\n/);
  assert.match(optIn, /- id: trial\n/);
  // Contract §3: canonical IDs change with configuration and are never configured.
  assert.doesNotMatch(settings, /local-active|qwen3\.8|- id: (?!daytime\n|nighttime\n|trial\n)/);
  // The opt-in route is never the default, so no fresh install or restore starts there.
  const defaultSelection = settings.match(/^agent-default-model:\n((?:[ \t]+.*\n)*)/m)?.[1] ?? "";
  assert.match(defaultSelection, /provider: local-ollama/);
  assert.doesNotMatch(defaultSelection, /trial/i);
});

test("every resident selection exposes an independent request contract", () => {
  for (const block of [canonical, expanded, optIn]) {
    assert.match(block, /baseURL: http:\/\/ai-router:11434\/v1/);
    assert.match(block, /maxTokens: null/);
    assert.match(block, /reasoning: medium/);
    assert.match(block, /off: none/);
    assert.match(block, /minimal: low/);
    assert.match(block, /high: xhigh/);
    assert.match(block, /max: xhigh/);
  }
  assert.match(canonical, /displayName: Daytime \(128K\)/);
  assert.match(canonical, /name: Daytime \(128K\)/);
  assert.match(canonical, /contextWindow: 131072/);
  assert.match(canonical, /maxConcurrency: 1/);
  assert.match(canonical, /input: \[text, image\]/);
  assert.match(expanded, /displayName: Nighttime \(128K\)/);
  assert.match(expanded, /name: Nighttime \(128K\)/);
  assert.match(expanded, /contextWindow: 131072/);
  assert.match(expanded, /maxConcurrency: 1/);
  assert.match(expanded, /input: \[text\]/);
  // The trial route is seeded text-only: it never inherits Daytime's modality.
  assert.match(optIn, /displayName: Trial \(128K\)/);
  assert.match(optIn, /name: Trial \(128K\)/);
  assert.match(optIn, /contextWindow: 131072/);
  assert.match(optIn, /maxConcurrency: 1/);
  assert.match(optIn, /input: \[text\]/);
});

test("busy retries stay bounded while context and timeout failures are not blindly retried", () => {
  for (const block of [canonical, expanded, optIn]) {
    assert.doesNotMatch(block, /^      timeoutMs:/m);
    assert.match(block, /streamIdleTimeoutMs: 900000/);
    assert.match(block, /maxRetries: 2/);
    assert.match(block, /retryableCodes: \[\s*EMPTY_RESPONSE, RATE_LIMIT, SERVER, TRANSPORT\s*\]/);
    const retryable = block.match(/retryableCodes: \[([^\]]+)\]/)?.[1] ?? "";
    assert.doesNotMatch(retryable, /TIMEOUT|CONTEXT_WINDOW_EXCEEDED/);
  }
});
