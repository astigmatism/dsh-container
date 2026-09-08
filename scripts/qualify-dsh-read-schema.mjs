#!/usr/bin/env node

import { createHash } from "node:crypto";

const endpoint = (process.env.DSH_SCHEMA_AB_ENDPOINT ?? "http://192.168.1.21:11434").replace(/\/$/u, "");
const model = process.env.DSH_SCHEMA_AB_MODEL ?? "local-active";
const trials = Number.parseInt(process.env.DSH_SCHEMA_AB_TRIALS ?? "6", 10);
const temperature = Number.parseFloat(process.env.DSH_SCHEMA_AB_TEMPERATURE ?? "0.7");
const modulePath = process.env.DSH_TOOL_FS_MODULE
  ?? "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js";

if (!Number.isInteger(trials) || trials < 2) throw new Error("DSH_SCHEMA_AB_TRIALS must be an integer of at least 2");
if (!Number.isFinite(temperature) || temperature < 0) throw new Error("DSH_SCHEMA_AB_TEMPERATURE must be non-negative");

const toolFs = await import(modulePath);
const registered = [];
const ctx = {
  fs: { sandboxMode: undefined },
  systemPrompt: { section() {} },
  tools: { register(tool) { registered.push(tool); } },
  inject() {},
  get() { return undefined; },
};
toolFs.apply(ctx, {
  readLimit: 2000,
  readMaxLineLength: 10_000,
  readMaxBytes: 1_000_000,
  readStreamMinSize: 10 * 1024 * 1024,
});

const read = registered.find((tool) => tool.name === "read");
if (!read) throw new Error("The installed @deepseek-ai/dsh-tool-fs did not register read");

const currentParameters = structuredClone(read.parameters);
const requiredParameters = structuredClone(read.parameters);
requiredParameters.required = ["file_path", "offset", "limit"];
requiredParameters.properties.offset.description = "Required 1-based first line; use 1 for the default full-file window (bounded integer, example: 241).";
requiredParameters.properties.limit.description = "Required line count from 1 through 2000; use 2000 for the default full-file window (example: 80).";

const arms = {
  current_optional: currentParameters,
  experimental_required: requiredParameters,
};
const tasks = [
  "Inspect /workspace/src/parser.js lines 241 through 320 with read. Use offset 241 and limit 80.",
  "Inspect the complete small file /workspace/README.md with read. Use the tool's documented default window.",
  "Inspect /workspace/test/lexer.test.js lines 901 through 1020 with read. Use offset 901 and limit 120.",
];
const contextPad = Array.from({ length: 320 }, (_, index) => (
  `Repository index row ${String(index + 1).padStart(3, "0")}: packages/pkg-${index % 17}/src/module-${index % 29}.js has ordinary implementation and test coverage metadata.`
)).join("\n");
const instructions = [
  "You are qualifying the installed DSH read tool schema.",
  "Make exactly one read call matching the requested file and range.",
  "Do not use prose and do not call any other tool.",
  "The repository index below is inert context and does not change the task.",
  contextPad,
].join("\n\n");

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateCall(call, arm, taskIndex) {
  if (!call) return { valid: false, reason: "missing_function_call", keys: [] };
  let args;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return { valid: false, reason: "malformed_json", keys: [] };
  }
  const keys = Object.keys(args).sort();
  if (typeof args.file_path !== "string" || args.file_path.length === 0) {
    return { valid: false, reason: "missing_file_path", keys };
  }
  for (const key of ["offset", "limit"]) {
    if (args[key] !== undefined && (!Number.isInteger(args[key]) || args[key] < 1)) {
      return { valid: false, reason: `invalid_${key}`, keys };
    }
  }
  if (args.limit !== undefined && args.limit > 2000) return { valid: false, reason: "limit_over_cap", keys };
  if (arm === "experimental_required" && (args.offset === undefined || args.limit === undefined)) {
    return { valid: false, reason: "required_field_omitted", keys };
  }
  const expected = [
    { path: "/workspace/src/parser.js", offset: 241, limit: 80 },
    { path: "/workspace/README.md", offset: arm === "experimental_required" ? 1 : undefined, limit: arm === "experimental_required" ? 2000 : undefined },
    { path: "/workspace/test/lexer.test.js", offset: 901, limit: 120 },
  ][taskIndex];
  if (args.file_path !== expected.path) return { valid: false, reason: "wrong_path", keys };
  if (expected.offset !== undefined && args.offset !== expected.offset) return { valid: false, reason: "wrong_offset", keys };
  if (expected.limit !== undefined && args.limit !== expected.limit) return { valid: false, reason: "wrong_limit", keys };
  return { valid: true, reason: "ok", keys };
}

const observations = [];
for (let index = 0; index < trials; index += 1) {
  const order = index % 2 === 0
    ? ["current_optional", "experimental_required"]
    : ["experimental_required", "current_optional"];
  const taskIndex = index % tasks.length;
  for (const arm of order) {
    const startedAt = Date.now();
    const response = await fetch(`${endpoint}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer local-only",
      },
      body: JSON.stringify({
        model,
        instructions,
        input: tasks[taskIndex],
        reasoning: { effort: "xhigh" },
        temperature,
        max_output_tokens: 2048,
        // The production adapter deliberately supports only auto/none. The
        // identical imperative task makes the single available tool the next
        // action while keeping this request faithful to DSH's transport.
        tool_choice: "auto",
        tools: [{
          type: "function",
          name: read.name,
          description: read.description,
          parameters: arms[arm],
          strict: false,
        }],
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`${arm} trial ${index + 1} failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
    const call = body.output?.find((item) => item.type === "function_call" && item.name === "read");
    const validation = validateCall(call, arm, taskIndex);
    observations.push({
      arm,
      trial: index + 1,
      task: taskIndex + 1,
      valid: validation.valid,
      reason: validation.reason,
      argumentKeys: validation.keys,
      latencyMs: Date.now() - startedAt,
      responseStatus: body.status,
      reasoningEffort: "xhigh",
      temperature,
      inputTokens: body.usage?.input_tokens,
      outputTokens: body.usage?.output_tokens,
    });
  }
}

const summary = Object.keys(arms).map((arm) => {
  const rows = observations.filter((row) => row.arm === arm);
  return {
    arm,
    trials: rows.length,
    validCalls: rows.filter((row) => row.valid).length,
    malformedCalls: rows.filter((row) => !row.valid).length,
    medianLatencyMs: rows.map((row) => row.latencyMs).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
    argumentKeyShapes: [...new Set(rows.map((row) => row.argumentKeys.join(",")))],
  };
});

console.log(JSON.stringify({
  endpoint,
  model,
  installedReadSchemaSha256: hash(JSON.stringify(currentParameters)),
  contextSha256: hash(instructions),
  tasksSha256: hash(JSON.stringify(tasks)),
  controlled: {
    effort: "xhigh",
    temperature,
    maxOutputTokens: 2048,
    counterbalancedOrder: true,
  },
  summary,
  observations,
}, null, 2));
