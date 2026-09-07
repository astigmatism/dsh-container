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
const legacy = providerBlock("local-ollama-256k");

test("canonical selection uses only the public alias and leaves effort at the medium provider default", () => {
  assert.match(settings, /^agent-default-model:\n  provider: local-ollama\n  model: local-active\n\n/m);
  assert.doesNotMatch(settings.slice(0, settings.indexOf("\npermission:")), /reasoningEffort:/);
  assert.equal((settings.match(/- id: local-active/g) ?? []).length, 2);
  assert.doesNotMatch(settings, /qwen3\.8|mtp|tensor.split/i);
});

test("canonical and compatibility provider IDs expose the same per-request contract", () => {
  for (const block of [canonical, legacy]) {
    assert.match(block, /baseURL: http:\/\/ai-router:11434\/v1/);
    assert.match(block, /contextWindow: 131072/);
    assert.match(block, /maxTokens: 32768/);
    assert.match(block, /maxConcurrency: 2/);
    assert.match(block, /reasoning: medium/);
    assert.match(block, /off: none/);
    assert.match(block, /minimal: low/);
    assert.match(block, /high: xhigh/);
    assert.match(block, /max: xhigh/);
    assert.doesNotMatch(block, /contextWindow: 262144/);
  }
  assert.match(legacy, /legacy ID; 128k total/);
});

test("busy retries stay bounded while context and timeout failures are not blindly retried", () => {
  for (const block of [canonical, legacy]) {
    assert.match(block, /timeoutMs: 600000/);
    assert.match(block, /streamIdleTimeoutMs: 600000/);
    assert.match(block, /maxRetries: 2/);
    assert.match(block, /retryableCodes: \[ EMPTY_RESPONSE, RATE_LIMIT, SERVER, TRANSPORT \]/);
    const retryable = block.match(/retryableCodes: \[([^\]]+)\]/)?.[1] ?? "";
    assert.doesNotMatch(retryable, /TIMEOUT|CONTEXT_WINDOW_EXCEEDED/);
  }
});
