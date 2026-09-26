#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loaderRow } from "./verify-dsh-token-policy.mjs";

if (process.argv.includes("--effective-config")) {
  let effective = "";
  for await (const chunk of process.stdin) effective += chunk;
  const shell = loaderRow(effective, "bash-sandbox");
  assert.match(shell, /^\s*timeoutMs: 120000\s*$/m, "foreground shell default must be two minutes");
  assert.match(shell, /^\s*maxTimeoutMs: 600000\s*$/m, "explicit shell timeouts must allow up to ten minutes");
  const loop = loaderRow(effective, "loop-detector");
  assert.doesNotMatch(loop, /^\s*testTimeoutMs:/m, "the loop detector must not configure a competing execution deadline");
  assert.match(loop, /^\s*repeatedTestTimeouts: 2\s*$/m);
  console.log("Verified native shell deadline policy: 120-second default, 600-second maximum, and two repeated test timeouts.");
  process.exit(0);
}

const profileRoot = process.env.DSH_PROFILE_ROOT ?? "/opt/dsh-seed/profiles/web";
const pluginPath = path.join(profileRoot, "node_modules/dsh-loop-detector/lib/index.js");
const { apply, inject, DEFAULT_PROGRESS_LIMITS } = await import(pathToFileURL(pluginPath).href);
const v4Path = "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js";
const { assertV4RowAdmission } = await import(pathToFileURL(v4Path).href);

function assertV4PluginMessage(message, trigger) {
  assert.deepEqual(message.source, { kind: "plugin:dsh-loop-detector" }, `${trigger} source`);
  assert.doesNotThrow(
    () => assertV4RowAdmission({ type: "user/message", data: message }),
    `${trigger} must pass the installed Harness V4 writer admission`,
  );
}

assert.deepEqual(inject, ["agents", "fs", "tools"]);

assert.deepEqual(DEFAULT_PROGRESS_LIMITS, {
  continuationDirective: 12,
  reasoningPrefixChars: 128,
  reasoningDirectiveOccurrence: 2,
  reasoningHardOccurrence: 3,
  readDefaultOffset: 1,
  readDefaultLimit: 2000,
  repeatedTestTimeouts: 2,
});

const handlers = new Map();
const cancels = [];
const warnings = [];
const steers = [];
const session = { id: "installed-semantic-progress", header: { cwd: "/workspace" } };
const agent = {
  id: session.id,
  session,
  steer(message) {
    steers.push(message);
  },
  cancel(cause) {
    cancels.push(cause);
  },
};
const ctx = {
  agents: { get: (id) => (String(id) === session.id ? agent : undefined) },
  fs: {
    async resolve(requested, options = {}) {
      const displayPath = path.resolve(options.cwd ?? session.header.cwd, requested || ".");
      return { displayPath, targetKey: displayPath };
    },
    async stat() {
      return { type: "file", size: 1, version: "fixture-v1" };
    },
  },
  tools: { get: (name) => (name === "str_replace_editor" ? { name } : undefined) },
  logger: {
    warn: (message) => warnings.push(message),
    error() {},
  },
  on(name, handler) {
    assert.equal(handlers.has(name), false, `duplicate ${name} handler`);
    handlers.set(name, handler);
  },
};

apply(ctx, { minLen: 128, ...DEFAULT_PROGRESS_LIMITS });
const event = handlers.get("session/event");
const preStep = handlers.get("agent/pre-step");
const execute = handlers.get("tools/execute");
assert.equal(typeof event, "function");
assert.equal(typeof preStep, "function");
assert.equal(typeof execute, "function");

function begin(turn, text) {
  event(session, { type: "turn/start", data: { turn } });
  event(session, {
    type: "user/message",
    data: {
      id: `human-${turn}`,
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: "user" },
    },
    surfaceOp: "append",
  });
}

async function runTool(name, args, outcome = { isError: false, value: {}, content: [] }) {
  let dispatched = false;
  const result = await execute(
    { name, arguments: args, agent, signal: new AbortController().signal },
    async () => {
      dispatched = true;
      return outcome;
    },
  );
  return { dispatched, result };
}

begin(1, "Implement the requested change and test it.");
await preStep({ agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: "enter", messages: [] }));
for (let index = 1; index <= 20; index += 1) {
  assert.equal((await runTool("read", { file_path: `src/${index}.js`, offset: 1, limit: 50 })).dispatched, true);
}
assert.equal(cancels.length, 0);
assert.equal((await runTool("todo_write", { todos: [{ content: "Inspect", status: "in_progress" }] })).dispatched, true);
assert.equal((await runTool("bash", { command: "git status --short 2>/dev/null" })).dispatched, true);
for (let index = 1; index <= 12; index += 1) {
  event(session, {
    type: "assistant/message",
    data: { turn: 1, step: index + 1, message: { content: [], source: { provider: "test", model: "test" } } },
    surfaceOp: "append",
  });
}
const correction = await preStep(
  { agent, turn: 1, step: 14, signal: new AbortController().signal },
  async () => ({ kind: "enter", messages: [] }),
);
assert.equal(correction.messages.length, 1);
assert.match(correction.messages[0].content[0].text, /trigger=continuation_no_progress_12/);
assertV4PluginMessage(correction.messages[0], "progress checkpoint");
assert.throws(
  () => assertV4RowAdmission({
    type: "user/message",
    data: { ...correction.messages[0], source: { kind: "plugin", plugin: "dsh-loop-detector" } },
  }),
  /format v4 message requires a producer-owned source kind/,
  "installed V4 validator must reject the retired plugin source",
);
for (let index = 13; index <= 48; index += 1) {
  event(session, {
    type: "assistant/message",
    data: { turn: 1, step: index + 1, message: { content: [], source: { provider: "test", model: "test" } } },
    surfaceOp: "append",
  });
}
assert.equal(cancels.length, 0, "distinct continued discovery must not be cancelled by a step count");
event(session, {
  type: "user/message",
  data: {
    id: "compaction-fact",
    role: "user",
    content: [{ type: "text", text: "sanitized checkpoint" }],
    source: { kind: "compact-basic" },
  },
  surfaceOp: { op: "replace", start: 1, end: 2 },
});
const compaction = await preStep(
  { agent, turn: 1, step: 51, signal: new AbortController().signal },
  async () => ({ kind: "enter", messages: [] }),
);
assert.equal(compaction.messages.length, 1);
assert.match(compaction.messages[0].content[0].text, /Compaction preserved/);
assertV4PluginMessage(compaction.messages[0], "compaction progress fact");

event(session, { type: "turn/end", data: { turn: 1, reason: { kind: "aborted" } } });
begin(2, "Read-only diagnosis; do not edit files.");
await preStep({ agent, turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: "enter", messages: [] }));
assert.equal((await runTool("read", { file_path: "src/a.js" })).dispatched, true);
const duplicate = await runTool("read", { file_path: "./src/a.js", offset: 1, limit: 2000 });
assert.equal(duplicate.dispatched, false);
assert.equal(duplicate.result.error.info.code, "DUPLICATE_READ_SUPPRESSED");
const repeated = await runTool("read", { file_path: "/workspace/src/a.js", offset: 1, limit: 2000 });
assert.equal(repeated.dispatched, false);
assert.equal(repeated.result.error.info.code, "SEMANTIC_DUPLICATE_READ_LOOP");
assert.match(cancels.at(-1).reason, /guard=duplicate_read_repeated/);

assert.ok(warnings.some((message) => /injected semantic progress correction/.test(message)));
begin(3, "Implement the fix and verify it.");
const timedOut = {
  isError: false,
  value: { timedOut: true, timeoutMs: 115000 },
  content: [{ type: "text", text: "Partial results: 3 passed; output saved to /tmp/test-output.log" }],
};
const loop = (files) => `for f in ${files}; do python -m pytest backend/tests/integration/$f.py -q; done`;
assert.equal((await runTool("bash", { command: loop("test_first test_second") }, timedOut)).result.error.info.code, "TEST_TIMEOUT");
assert.equal((await runTool("bash", { command: "python -m pytest backend/tests/integration/test_first.py -q" })).result.isError, false);
const remaining = await runTool("bash", { command: loop("test_second") }, timedOut);
assert.equal(remaining.result.error.info.code, "TEST_TIMEOUT");
assert.match(JSON.stringify(remaining.result.content), /Partial results: 3 passed/);
assert.equal(cancels.length, 1, "narrowed test batches after completed tests must not cancel");
const retry = await runTool("bash", { command: loop("test_second") }, timedOut);
assert.equal(retry.result.error.info.code, "REPEATED_TEST_TIMEOUT");
assert.match(JSON.stringify(retry.result.content), /test-output\.log/);
assert.match(cancels.at(-1).reason, /guard=repeated_test_timeout/);

begin(4, "Answer the request concisely.");
event(session, {
  type: "assistant/chunk",
  data: {
    turn: 4,
    step: 1,
    chunk: { type: "text-delta", index: 0, text: "meaningful repeated output. ".repeat(8) },
  },
});
assert.equal(steers.length, 1);
assert.match(steers[0].content[0].text, /Repeated output was detected/);
assertV4PluginMessage(steers[0], "repeated output correction");

event(session, { type: "turn/end", data: { turn: 4, reason: { kind: "completed" } } });
begin(5, "Research the Harness source format.");
for (const query of [
  "deepseek harness v4 source kind",
  "deepseek harness v4 source kinds",
  "deepseek harness v4 source kind syntax",
]) {
  assert.equal((await runTool("web_search", { query })).dispatched, true);
}
assert.equal(steers.length, 2);
assert.match(steers[1].content[0].text, /Repeated searches on the same topic/);
assertV4PluginMessage(steers[1], "repeated search correction");

console.log("Verified installed V4 loop-detector messages, semantic progress, test-batch recovery, and timeout containment.");
