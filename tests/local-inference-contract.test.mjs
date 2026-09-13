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
const expanded = providerBlock("local-everyday");

test("canonical selection uses only the public alias and seeds the deliberate DSH medium default", () => {
  assert.match(settings, /^agent-default-model:\n  provider: local-ollama\n  model: local-active\n  reasoningEffort: medium\n\n/m);
  assert.match(settings.slice(0, settings.indexOf("\npermission:")), /reasoningEffort: medium/);
  assert.equal((settings.match(/- id: local-active/g) ?? []).length, 1);
  assert.match(expanded, /- id: qwen3\.8-27b-abliterated-q6_k/);
});

test("Daytime 144K and Nighttime 128K selections expose independent request contracts", () => {
  for (const block of [canonical, expanded]) {
    assert.match(block, /baseURL: http:\/\/ai-router:11434\/v1/);
    assert.match(block, /maxTokens: null/);
    assert.match(block, /reasoning: medium/);
    assert.match(block, /off: none/);
    assert.match(block, /minimal: low/);
    assert.match(block, /high: xhigh/);
    assert.match(block, /max: xhigh/);
  }
  assert.match(canonical, /displayName: Daytime \(144K\)/);
  assert.match(canonical, /name: Daytime \(144K\)/);
  assert.match(canonical, /contextWindow: 147456/);
  assert.match(canonical, /maxConcurrency: 1/);
  assert.match(expanded, /displayName: Nighttime \(128K\)/);
  assert.match(expanded, /name: Nighttime \(128K\)/);
  assert.match(expanded, /contextWindow: 131072/);
  assert.match(expanded, /maxConcurrency: 1/);
});

test("busy retries stay bounded while context and timeout failures are not blindly retried", () => {
  for (const block of [canonical, expanded]) {
    assert.doesNotMatch(block, /^      timeoutMs:/m);
    assert.match(block, /streamIdleTimeoutMs: 600000/);
    assert.match(block, /maxRetries: 2/);
    assert.match(block, /retryableCodes: \[\s*EMPTY_RESPONSE, RATE_LIMIT, SERVER, TRANSPORT\s*\]/);
    const retryable = block.match(/retryableCodes: \[([^\]]+)\]/)?.[1] ?? "";
    assert.doesNotMatch(retryable, /TIMEOUT|CONTEXT_WINDOW_EXCEEDED/);
  }
});
