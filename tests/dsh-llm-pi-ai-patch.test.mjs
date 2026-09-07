import assert from "node:assert/strict";
import test from "node:test";

import {
  EndpointConcurrencyGate,
  patchSource,
  renderStructuredError,
} from "../scripts/patch-dsh-llm-pi-ai.mjs";

const fixture = `
function readListing(body) {
\tfor (const raw of body.data) {
\t\tconst entry = raw;
\t\tconst name = label(entry?.name, entry?.display_name);
\t\tconst contextWindow = capacity(entry?.context_window, entry?.context_length);
\t\tconst maxTokens = capacity(entry?.max_output_tokens, entry?.max_tokens);
\t}
}
const profile = z.object({
\tstreamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
\tmaxRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),
});
function resolveProfiles(providers) {
\tfor (const [provider, source] of Object.entries(providers ?? {})) {
\t\tconst streamIdleTimeoutMs = source.streamIdleTimeoutMs ?? 3e5;
\t\tif (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(\`llm-pi-ai: provider "\${provider}" streamIdleTimeoutMs must be a positive finite number no greater than \${MAX_TIMER_DELAY_MS}\`);
\t\tconst maxRequestImageBytes = source.maxRequestImageBytes ?? 20971520;
\t}
}
function classifyPiAiError(message) {
\treturn "PI_AI_ERROR";
}
function mapStopReason(message, contextWindow) {
\tconst piAiOverflow = isContextOverflow(message, contextWindow);
\tconst harnessOverflow = message.stopReason === "error" && message.errorMessage !== void 0 && isContextWindowExceededError(message.errorMessage);
\tif (piAiOverflow || harnessOverflow) return {
\t\tkind: "error",
\t\tfailure: {
\t\t\tmessage: message.errorMessage ?? \`pi-ai detected context overflow for model "\${message.model}"\`,
\t\t\tcode: CONTEXT_WINDOW_EXCEEDED_CODE
\t\t}
\t};
\tswitch (message.stopReason) {
\t\tcase "aborted": return {
\t\t\tkind: "aborted",
\t\t\tfailure: {
\t\t\t\tmessage: message.errorMessage ?? "pi-ai stream aborted",
\t\t\t\tcode: "ABORTED"
\t\t\t}
\t\t};
\t\tcase "error": {
\t\t\tconst text = message.errorMessage ?? "pi-ai stream error";
\t\t\treturn { kind: "error", failure: { message: text, code: classifyPiAiError(text) } };
\t\t}
\t}
}
const afterMapStopReason = true;
var PiAiAdapter = class extends LlmAdapter {
\tconfig;
\tsnapshot;
\tasync *streamWithSnapshot(options, snapshot) {
\t\tconst env_1 = { stack: [] };
\t\tconst profile = this.profileOf(snapshot, options.provider);
\t\tconst model = this.modelOf(snapshot, options.provider, options.model);
\t\tconst consumer = new AbortController();
\t\tconst upstream = options.signal === void 0 ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
\t\tconst streamIdleTimeoutMs = profile.streamIdleTimeoutMs;
\t\t\tconst watchdog = __addDisposableResource(env_1, idleWatchdog(upstream, streamIdleTimeoutMs, "LLM_STREAM_IDLE_TIMEOUT"), false);
\t\t\ttry {
\t\t\tconst context = {};
\t\t\t\tconst iterator = toStreamChunks(snapshot.models.streamSimple(model, context, {
\t\t\t}), model.contextWindow)[Symbol.asyncIterator]();
\t\t\tyield iterator;
\t\t\t} finally {
\t\t\t\tconsumer.abort("pi-ai stream consumer stopped");
\t\t\t}
\t}
};
`;

function evaluatePatchedFixture() {
  const patched = patchSource(fixture);
  const start = patched.indexOf("function renderPiAiError");
  const end = patched.indexOf("const afterMapStopReason");
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return Function(
    "isContextOverflow",
    "isContextWindowExceededError",
    "CONTEXT_WINDOW_EXCEEDED_CODE",
    `${patched.slice(start, end)}\nreturn { mapStopReason };`,
  )(() => false, () => false, "CONTEXT_WINDOW_EXCEEDED");
}

test("pinned pi-ai patch consumes router capacities and normalizes stream errors", () => {
  const patched = patchSource(fixture);
  assert.match(patched, /reasoning\?\.absolute_max_output_tokens/);
  assert.match(patched, /maxConcurrency: z\.number\(\)\.step\(1\)\.min\(1\)/);
  assert.match(patched, /new EndpointConcurrencyGate/);
  assert.match(patched, /concurrency\.acquire\(profile, upstream\)/);
  assert.match(patched, /releaseConcurrency\?\.\(\)/);
  assert.match(patched, /const errorText =/);
  assert.match(patched, /message: errorText/);
  assert.equal(patchSource(patched), patched, "patch is idempotent");
});

test("endpoint concurrency gate shares two generation slots across provider aliases", async () => {
  const gate = new EndpointConcurrencyGate();
  const canonical = { provider: "local-ollama", baseURL: "http://ai-router:11434/v1", maxConcurrency: 2 };
  const legacy = { provider: "local-ollama-256k", baseURL: "http://ai-router:11434/v1/", maxConcurrency: 2 };
  const releaseFirst = await gate.acquire(canonical);
  const releaseSecond = await gate.acquire(legacy);
  let thirdStarted = false;
  const third = gate.acquire(canonical).then((release) => {
    thirdStarted = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(thirdStarted, false);
  releaseFirst();
  const releaseThird = await third;
  assert.equal(thirdStarted, true);
  releaseSecond();
  releaseThird();
});

test("queued generation can be cancelled without consuming a slot", async () => {
  const gate = new EndpointConcurrencyGate();
  const profile = { provider: "local", baseURL: "http://router/v1", maxConcurrency: 1 };
  const release = await gate.acquire(profile);
  const controller = new AbortController();
  const queued = gate.acquire(profile, controller.signal);
  controller.abort(new Error("cancelled"));
  await assert.rejects(queued, /cancelled/);
  release();
  const nextRelease = await gate.acquire(profile);
  nextRelease();
});

test("structured router errors retain their code and message", () => {
  assert.equal(
    renderStructuredError({ error: { code: "OUTPUT_LIMIT_EXCEEDED", message: "maximum is 16384" } }),
    "OUTPUT_LIMIT_EXCEEDED: maximum is 16384",
  );
  assert.equal(renderStructuredError({ message: "request failed", code: "INVALID_REQUEST" }), "INVALID_REQUEST: request failed");
});

test("structured error fallback is JSON rather than object coercion", () => {
  assert.equal(renderStructuredError({ status: 400, detail: "bad request" }), '{"status":400,"detail":"bad request"}');
});

test("generated adapter classifies a structured router error without losing its message", () => {
  const { mapStopReason } = evaluatePatchedFixture();
  assert.deepEqual(
    mapStopReason({
      stopReason: "error",
      errorMessage: { error: { code: "OUTPUT_LIMIT_EXCEEDED", message: "maximum is 16384" } },
    }, 131072),
    {
      kind: "error",
      failure: {
        message: "OUTPUT_LIMIT_EXCEEDED: maximum is 16384",
        code: "PI_AI_ERROR",
      },
    },
  );
});
