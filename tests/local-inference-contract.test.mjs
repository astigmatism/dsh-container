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

const canonical = providerBlock("local-ollama", "local-ollama-256k");
const expanded = providerBlock("local-ollama-256k");

test("canonical selection uses only the public alias and leaves effort at the medium provider default", () => {
  assert.match(settings, /^agent-default-model:\n  provider: local-ollama\n  model: local-active\n\n/m);
  assert.doesNotMatch(settings.slice(0, settings.indexOf("\npermission:")), /reasoningEffort:/);
  assert.equal((settings.match(/- id: local-active/g) ?? []).length, 2);
  assert.doesNotMatch(settings, /qwen3\.8|mtp|tensor.split/i);
});

test("128K and 256K selections expose their distinct request contracts", () => {
  for (const block of [canonical, expanded]) {
    assert.match(block, /baseURL: http:\/\/ai-router:11434\/v1/);
    assert.match(block, /maxTokens: 32768/);
    assert.match(block, /reasoning: medium/);
    assert.match(block, /off: none/);
    assert.match(block, /minimal: low/);
    assert.match(block, /high: xhigh/);
    assert.match(block, /max: xhigh/);
  }
  assert.match(canonical, /displayName: Local Router \(128K context\)/);
  assert.match(canonical, /name: Local Active Model \(128K context\)/);
  assert.match(canonical, /contextWindow: 131072/);
  assert.match(canonical, /maxConcurrency: 2/);
  assert.match(expanded, /displayName: Local Router \(256K context\)/);
  assert.match(expanded, /name: Local Active Model \(256K context\)/);
  assert.match(expanded, /contextWindow: 262144/);
  assert.match(expanded, /maxConcurrency: 1/);
});

test("busy retries stay bounded while context and timeout failures are not blindly retried", () => {
  for (const block of [canonical, expanded]) {
    assert.match(block, /timeoutMs: 600000/);
    assert.match(block, /streamIdleTimeoutMs: 600000/);
    assert.match(block, /maxRetries: 2/);
    assert.match(block, /retryableCodes: \[\s*EMPTY_RESPONSE, RATE_LIMIT, SERVER, TRANSPORT\s*\]/);
    const retryable = block.match(/retryableCodes: \[([^\]]+)\]/)?.[1] ?? "";
    assert.doesNotMatch(retryable, /TIMEOUT|CONTEXT_WINDOW_EXCEEDED/);
  }
});
