#!/usr/bin/env node

import assert from "node:assert/strict";

const mode = process.argv[2];
const DSH_ROOT = mode === undefined || mode.startsWith("--")
  ? "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules"
  : mode;
const { CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError } = await import(
  `file://${DSH_ROOT}/@deepseek-ai/dsh-llm/lib/index.js`
);
const { BasicCompactionEngine } = await import(
  `file://${DSH_ROOT}/@deepseek-ai/dsh-compaction-basic/lib/index.js`
);

const CONTEXT_WINDOW = 131072;
const INCIDENT_MEASUREMENT = 99735;

function config(thresholdRatio = 0.70) {
  return {
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    summarizationProvider: "",
    summarizationModel: "",
    maxTokens: 8192,
    compactionRetries: 1,
    maxOverflowRetries: 1,
    modelPolicies: [
      { provider: "local-ollama", model: "local-active", thresholdRatio },
      { provider: "local-ollama-256k", model: "local-active", thresholdRatio },
    ],
    auto: true,
  };
}

function userEvent(seq) {
  return {
    type: "user/message",
    seq,
    data: {
      role: "user",
      content: [{ type: "text", text: `fixture-${seq}` }],
      source: { kind: "user" },
      id: `fixture-${seq}`,
    },
    surfaceOp: "append",
  };
}

function pressureAgent(provider) {
  const events = [userEvent(0), userEvent(1), userEvent(2)];
  return {
    options: { provider, model: "local-active" },
    session: {
      events,
      surface: { nodes: [0, 1, 2], replaceGeneration: 0 },
      requestHeader() {
        return { config: { provider, model: "local-active", maxTokens: 32768 } };
      },
    },
  };
}

function pressureEngine(provider, thresholdRatio = 0.70) {
  const agent = pressureAgent(provider);
  let compactCalls = 0;
  const high = {
    totalTokens: INCIDENT_MEASUREMENT,
    surfaceTokens: INCIDENT_MEASUREMENT,
    nodes: [
      { seq: 0, tokens: 60000 },
      { seq: 1, tokens: 20000 },
      { seq: 2, tokens: 19735 },
    ],
  };
  const low = { ...high, totalTokens: 30000 };
  const engine = Object.create(BasicCompactionEngine.prototype);
  Object.assign(engine, {
    config: config(thresholdRatio),
    ctx: {
      llm: {
        async resolveModelInfo() {
          return { context: { contextWindow: CONTEXT_WINDOW } };
        },
      },
      tokenMeter: {
        measure() {
          return compactCalls === 0 ? high : low;
        },
      },
      get() {
        return undefined;
      },
    },
    async compactRegion(start, end) {
      compactCalls += 1;
      return {
        shadowedSeqs: [start],
        shadowedRange: { start, end },
        shadowedTokenCount: 60000,
      };
    },
  });
  return { agent, engine, compactCalls: () => compactCalls };
}

for (const provider of ["local-ollama", "local-ollama-256k"]) {
  const fixture = pressureEngine(provider);
  const result = await fixture.engine.compactIfNeeded(
    fixture.agent,
    "pressure",
    new AbortController().signal,
  );
  assert.notEqual(result, null, `${provider} must compact the incident-sized pre-step surface`);
  assert.equal(fixture.compactCalls(), 1);
}

const oldDefault = pressureEngine("local-ollama", 0.8);
assert.equal(
  await oldDefault.engine.compactIfNeeded(
    oldDefault.agent,
    "pressure",
    new AbortController().signal,
  ),
  null,
  "the old 80% policy reproduces the missed proactive trigger",
);
assert.equal(oldDefault.compactCalls(), 0);

const observed =
  'OpenAI API error (400): {"message":"Formatted input (101165) plus requested output (32768) and safety reserve (1024) exceeds the 131072-token slot.","type":"invalid_request_error","param":"messages","code":"CONTEXT_LIMIT_EXCEEDED"}';
assert.equal(isContextWindowExceededError("CONTEXT_LIMIT_EXCEEDED"), true);
assert.equal(isContextWindowExceededError(observed), true);
assert.equal(isContextWindowExceededError("context_length_exceeded"), true);

function recoveryEngine(compact) {
  const listeners = new Map();
  const engine = Object.create(BasicCompactionEngine.prototype);
  Object.assign(engine, {
    config: config(),
    warnedPressureConfigTargets: new Set(),
    overflowRetries: new WeakMap(),
    overflowAgents: new WeakMap(),
    compactIfNeeded: compact,
    ctx: {
      logger: { info() {}, warn() {} },
      on(name, listener) {
        listeners.set(name, listener);
      },
    },
  });
  engine._registerAutomaticCompaction();
  return { engine, listeners };
}

function recoveryAgent() {
  return {
    session: {
      surface: { replaceGeneration: 0 },
      requestHeader() {
        return { config: { provider: "local-ollama", model: "local-active" } };
      },
    },
  };
}

let successfulCompactions = 0;
const success = recoveryEngine(async (agent, trigger) => {
  assert.equal(trigger, "context-overflow");
  successfulCompactions += 1;
  agent.session.surface.replaceGeneration += 1;
  return {
    shadowedSeqs: [0],
    shadowedRange: { start: 0, end: 0 },
    shadowedTokenCount: 1,
  };
});
const successListener = success.listeners.get("agent/request-error");
assert.equal(typeof successListener, "function");
const successAgent = recoveryAgent();
let downstreamCalls = 0;
const payload = {
  agent: successAgent,
  failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE, message: observed },
  signal: new AbortController().signal,
};
assert.deepEqual(await successListener(payload, async () => { downstreamCalls += 1; }), { kind: "retry" });
assert.equal(successfulCompactions, 1);
assert.equal(downstreamCalls, 0, "canonical overflow recovery bypasses ordinary downstream retry handling");
assert.equal(
  await successListener(payload, async () => { downstreamCalls += 1; return "original"; }),
  "original",
  "overflow retry is bounded to one attempt for the route",
);
assert.equal(successfulCompactions, 1);
assert.equal(downstreamCalls, 1);

let failedCompactions = 0;
const failure = recoveryEngine(async () => {
  failedCompactions += 1;
  throw new Error("fixture compaction failed");
});
const failureAgent = recoveryAgent();
const failureListener = failure.listeners.get("agent/request-error");
let originalPreserved = 0;
assert.equal(
  await failureListener(
    { ...payload, agent: failureAgent },
    async () => { originalPreserved += 1; return "preserve-original"; },
  ),
  "preserve-original",
);
assert.equal(failedCompactions, 1);
assert.equal(originalPreserved, 1, "no-progress compaction failure must preserve the provider failure");

if (mode === "--effective-config") {
  let effective = "";
  for await (const chunk of process.stdin) effective += chunk;
  const row = (id, nextId) => {
    const start = effective.indexOf(`- id: ${id}\n`);
    assert.notEqual(start, -1, `effective Web composition is missing ${id}`);
    const end = effective.indexOf(`- id: ${nextId}\n`, start + 1);
    assert.notEqual(end, -1, `effective Web composition is missing following row ${nextId}`);
    return effective.slice(start, end);
  };
  const compact = row("compaction-basic", "command-compact");
  assert.doesNotMatch(compact, /disabled: true/);
  assert.match(compact, /auto: true/);
  assert.match(compact, /provider: local-ollama\n\s+model: local-active\n\s+thresholdRatio: 0\.7/);
  assert.match(compact, /provider: local-ollama-256k\n\s+model: local-active\n\s+thresholdRatio: 0\.7/);
  assert.doesNotMatch(row("command-compact", "subagent"), /disabled: true/);
  assert.doesNotMatch(row("tool-result-pruner", "tool-todo"), /disabled: true/);
}

console.log("Verified incident pressure policy, shared context classification, and bounded compaction recovery.");
