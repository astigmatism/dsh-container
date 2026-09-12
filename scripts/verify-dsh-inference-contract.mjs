#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DSH_ROOT = process.argv[2] ?? "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules";
const PI_ROOT = DSH_ROOT + "/@earendil-works/pi-ai/dist";
const ADAPTER_PATH = DSH_ROOT + "/@deepseek-ai/dsh-llm-pi-ai/lib/index.js";
const LLM_PATH = DSH_ROOT + "/@deepseek-ai/dsh-llm/lib/index.js";

function requireMarkers(label, source, markers) {
  for (const marker of markers) {
    assert.ok(source.includes(marker), label + " is missing contract marker: " + marker);
  }
}

const adapter = await readFile(ADAPTER_PATH, "utf8");
const llm = await readFile(LLM_PATH, "utf8");
const estimate = await readFile(PI_ROOT + "/utils/estimate.js", "utf8");
const responses = await readFile(PI_ROOT + "/api/openai-responses.js", "utf8");
const responsesShared = await readFile(PI_ROOT + "/api/openai-responses-shared.js", "utf8");

requireMarkers("dsh-llm-pi-ai", adapter, [
  "dsh-router-contract-v2",
  "maxConcurrency: z.number().step(1).min(1)",
  "releaseConcurrency = await this.concurrency.acquire(profile, upstream)",
  "releaseConcurrency?.()",
  "replayState: toPiReplayState(event.message, requestedModel)",
  'case "reasoning": return {',
  "thinking: block.text",
  "thinkingSignature: replay.thinkingSignature",
  "maxRetries: 0",
]);
requireMarkers("dsh-llm shared overflow classifier", llm, [
  "dsh-router-context-overflow-v1",
  "isRouterContextOverflowDetail(detail)",
  "token[\\s_-]+slot",
]);
requireMarkers("pi-ai context estimator", estimate, [
  "const CHARS_PER_TOKEN = 4",
  "const ESTIMATED_IMAGE_CHARS = 4800",
  'message.role === "toolResult"',
  'block.type === "thinking"',
  "safeJsonStringify(block.arguments)",
  "estimateToolsTokens(context.tools)",
  "estimateTextTokens(context.systemPrompt)",
]);
requireMarkers("pi-ai OpenAI Responses transport", responses, [
  "params.max_output_tokens = (model.maxTokens === null ? options.maxTokens : Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS))",
  'const reasoningEffort = clampedReasoning === "off" && model.maxTokens !== null ? undefined : clampedReasoning',
  'effort: (model.thinkingLevelMap?.off ?? "none")',
  'params.include = ["reasoning.encrypted_content"]',
  "maxRetries: 0",
]);
requireMarkers("pi-ai Responses replay", responsesShared, [
  'if (block.type === "thinking")',
  "const reasoningItem = JSON.parse(block.thinkingSignature)",
  "output.push(reasoningItem)",
  'type: "function_call_output"',
  "block.thinkingSignature = JSON.stringify(item)",
]);

const { clampMaxTokensToContext } = await import(
  pathToFileURL(PI_ROOT + "/api/simple-options.js").href
);
const { estimateContextTokens } = await import(
  pathToFileURL(PI_ROOT + "/utils/estimate.js").href
);
const { convertResponsesMessages } = await import(
  pathToFileURL(PI_ROOT + "/api/openai-responses-shared.js").href
);

const model = {
  id: "local-active",
  provider: "local-ollama",
  api: "openai-responses",
  baseUrl: "http://ai-router:11434/v1",
  contextWindow: 131072,
  maxTokens: 32768,
  reasoning: true,
  input: ["text", "image"],
};
const context = {
  systemPrompt: "s".repeat(4096),
  tools: [{
    name: "lookup",
    description: "d".repeat(4096),
    parameters: { type: "object", properties: { query: { type: "string" } } },
  }],
  messages: [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "r".repeat(4096) },
        { type: "toolCall", id: "call_1|fc_1", name: "lookup", arguments: { query: "q".repeat(4096) } },
      ],
      api: "openai-responses",
      provider: "local-ollama",
      model: "local-active",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      stopReason: "toolUse",
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "call_1|fc_1",
      toolName: "lookup",
      content: [{ type: "text", text: "t".repeat(4096) }],
      timestamp: 2,
    },
  ],
};
const estimated = estimateContextTokens(context).tokens;
assert.ok(estimated > 4096, "serialized system, tools, reasoning, calls, and results must all consume budget");
assert.equal(
  clampMaxTokensToContext(model, context, 32768),
  Math.min(32768, Math.max(1, 131072 - estimated - 4096)),
  "output allowance must be the requested cap clamped to total per-request capacity with safety reserve",
);
const oversized = { systemPrompt: "x".repeat(131072 * 4), tools: [], messages: [] };
assert.equal(
  clampMaxTokensToContext(model, oversized, 32768),
  1,
  "an already oversized estimated context must not retain the configured 32768-token output allowance",
);

const reasoningItem = {
  type: "reasoning",
  id: "rs_1",
  summary: [],
  encrypted_content: "opaque-reasoning-state",
};
const replayContext = {
  messages: [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "summary", thinkingSignature: JSON.stringify(reasoningItem) },
        { type: "toolCall", id: "call_1|fc_1", name: "lookup", arguments: { query: "status" } },
      ],
      api: "openai-responses",
      provider: "local-ollama",
      model: "local-active",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      stopReason: "toolUse",
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "call_1|fc_1",
      toolName: "lookup",
      content: [{ type: "text", text: "ready" }],
      timestamp: 2,
    },
  ],
};
const converted = convertResponsesMessages(model, replayContext, new Set(["local-ollama"]));
assert.deepEqual(converted.map((item) => item.type), [
  "reasoning",
  "function_call",
  "function_call_output",
]);
assert.equal(converted[0].encrypted_content, reasoningItem.encrypted_content);

console.log("Verified per-request budgeting, concurrency, retry ownership, reasoning-off, and tool-continuation replay.");
