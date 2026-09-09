#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const profileRoot = process.env.DSH_PROFILE_ROOT ?? "/opt/dsh-seed/profiles/web";
const pluginPath = path.join(profileRoot, "node_modules/dsh-loop-detector/lib/index.js");
const { apply, inject, DEFAULT_PROGRESS_LIMITS } = await import(pathToFileURL(pluginPath).href);

assert.deepEqual(inject, ["agents", "fs", "tools"]);

assert.deepEqual(DEFAULT_PROGRESS_LIMITS, {
  continuationDirective: 12,
  reasoningPrefixChars: 128,
  reasoningDirectiveOccurrence: 2,
  reasoningHardOccurrence: 3,
  readDefaultOffset: 1,
  readDefaultLimit: 2000,
});

const handlers = new Map();
const cancels = [];
const warnings = [];
const session = { id: "installed-semantic-progress", header: { cwd: "/workspace" } };
const agent = {
  id: session.id,
  session,
  steer() {},
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

apply(ctx, { minLen: 10000, ...DEFAULT_PROGRESS_LIMITS });
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

async function runTool(name, args) {
  let dispatched = false;
  const result = await execute(
    { name, arguments: args, agent, signal: new AbortController().signal },
    async () => {
      dispatched = true;
      return { isError: false, value: {}, content: [] };
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
for (let index = 13; index <= 48; index += 1) {
  event(session, {
    type: "assistant/message",
    data: { turn: 1, step: index + 1, message: { content: [], source: { provider: "test", model: "test" } } },
    surfaceOp: "append",
  });
}
assert.equal(cancels.length, 0, "distinct continued discovery must not be cancelled by a step count");

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
console.log("Verified advisory implementation checkpoint, unrestricted distinct discovery, accurate mutation accounting, and duplicate suppression/termination.");
