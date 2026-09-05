import assert from "node:assert/strict";
import test from "node:test";

import { patchSource, renderStructuredError } from "../scripts/patch-dsh-llm-pi-ai.mjs";

const fixture = `
function readListing(body) {
\tfor (const raw of body.data) {
\t\tconst entry = raw;
\t\tconst name = label(entry?.name, entry?.display_name);
\t\tconst contextWindow = capacity(entry?.context_window, entry?.context_length);
\t\tconst maxTokens = capacity(entry?.max_output_tokens, entry?.max_tokens);
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
`;

test("pinned pi-ai patch consumes router capacities and normalizes stream errors", () => {
  const patched = patchSource(fixture);
  assert.match(patched, /reasoning\?\.absolute_max_output_tokens/);
  assert.match(patched, /const errorText =/);
  assert.match(patched, /message: errorText/);
  assert.equal(patchSource(patched), patched, "patch is idempotent");
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
