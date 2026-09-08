import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const patchPath = path.join(projectRoot, "seed/profile/patches/dsh-loop-detector@1.0.0.patch");
const temporaryRoots = [];

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

function addedFileFromPatch(patch, wantedPath) {
  const lines = patch.split("\n");
  const header = `+++ b/${wantedPath}`;
  const start = lines.indexOf(header);
  if (start < 0) throw new Error(`patch does not add ${wantedPath}`);

  const output = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("diff --git ")) break;
    if (line.startsWith("@@") || line === "\\ No newline at end of file") continue;
    if (line.startsWith("+")) output.push(line.slice(1));
  }
  if (output.length === 0) throw new Error(`patch contains no generated source for ${wantedPath}`);
  return `${output.join("\n")}\n`;
}

async function productionPluginSource() {
  if (process.env.DSH_LOOP_DETECTOR_SOURCE) {
    return readFile(process.env.DSH_LOOP_DETECTOR_SOURCE, "utf8");
  }
  return addedFileFromPatch(await readFile(patchPath, "utf8"), "lib/index.js");
}

async function loadGeneratedPlugin() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-loop-detector-contract-"));
  temporaryRoots.push(root);
  const pluginDirectory = path.join(root, "node_modules/dsh-loop-detector");
  const llmDirectory = path.join(root, "node_modules/@deepseek-ai/dsh-llm");
  await mkdir(path.join(pluginDirectory, "lib"), { recursive: true });
  await mkdir(llmDirectory, { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(path.join(pluginDirectory, "package.json"), '{"name":"dsh-loop-detector","type":"module","main":"lib/index.js"}\n');
  await writeFile(path.join(pluginDirectory, "lib/index.js"), await productionPluginSource());
  await writeFile(path.join(llmDirectory, "package.json"), '{"name":"@deepseek-ai/dsh-llm","type":"module","main":"index.js"}\n');
  await writeFile(
    path.join(llmDirectory, "index.js"),
    "export const createUserMessage = (message) => ({ id: 'contract-message', ...message });\n",
  );
  return import(`${pathToFileURL(path.join(pluginDirectory, "lib/index.js")).href}?contract=${Date.now()}-${Math.random()}`);
}

function contractHarness(apply, config = {}) {
  const handlers = new Map();
  const steers = [];
  const cancels = [];
  const warnings = [];
  const errors = [];
  const executions = [];
  const versions = new Map();
  const session = { id: "contract-session", header: { cwd: "/workspace" } };
  const agent = {
    id: session.id,
    session,
    steer(message) {
      steers.push(message);
    },
    cancel(reason) {
      cancels.push(reason);
    },
  };
  const ctx = {
    agents: { get: (id) => (String(id) === session.id ? agent : undefined) },
    fs: {
      async resolve(requested, options = {}) {
        const resolved = path.resolve(options.cwd ?? session.header.cwd, requested || ".");
        return { displayPath: resolved, targetKey: resolved };
      },
      async stat(target) {
        return { type: "file", size: 100, version: versions.get(target.displayPath) ?? "v1" };
      },
    },
    tools: {
      get(name) {
        return ["str_replace_editor", "write", "edit", "bash", "run_code"].includes(name) ? { name } : undefined;
      },
    },
    logger: {
      warn: (message) => warnings.push(message),
      error: (message) => errors.push(message),
    },
    on(name, handler) {
      assert.equal(handlers.has(name), false, `duplicate ${name} handler`);
      handlers.set(name, handler);
    },
  };
  apply(ctx, { minLen: 512, maxRetries: 1, checkReasoning: true, ...config });
  const onSessionEvent = handlers.get("session/event");
  const onPreStep = handlers.get("agent/pre-step");
  const onTool = handlers.get("tools/execute");
  assert.equal(typeof onSessionEvent, "function");
  assert.equal(typeof onPreStep, "function");
  assert.equal(typeof onTool, "function");

  let turn = 0;
  let step = 0;

  return {
    steers,
    cancels,
    warnings,
    errors,
    executions,
    begin(text, nextTurn = turn + 1) {
      turn = nextTurn;
      step = 0;
      onSessionEvent(session, { type: "turn/start", data: { turn } });
      onSessionEvent(session, {
        type: "user/message",
        data: {
          id: `human-${turn}`,
          role: "user",
          content: [{ type: "text", text }],
          source: { kind: "user" },
        },
        surfaceOp: "append",
      });
    },
    async preStep() {
      step += 1;
      return onPreStep(
        { agent, turn, step, signal: new AbortController().signal, messages: [] },
        async () => ({ kind: "enter", messages: [] }),
      );
    },
    async tool(name, args, result = { isError: false, value: {}, content: [] }) {
      const controller = new AbortController();
      let dispatched = false;
      const output = await onTool(
        { name, arguments: args, agent, signal: controller.signal },
        async () => {
          dispatched = true;
          executions.push({ name });
          return result;
        },
      );
      return { result: output, dispatched };
    },
    continuation(reasoning, sizes = [reasoning.length]) {
      step += 1;
      let offset = 0;
      let index = 0;
      while (offset < reasoning.length) {
        const size = sizes[index % sizes.length];
        const text = reasoning.slice(offset, offset + size);
        onSessionEvent(session, {
          type: "assistant/chunk",
          data: { turn, step, chunk: { type: "reasoning-delta", index: 0, text } },
        });
        offset += text.length;
        index += 1;
      }
      onSessionEvent(session, {
        type: "assistant/message",
        data: { turn, step, message: { content: [], source: { provider: "test", model: "test" } } },
        surfaceOp: "append",
      });
    },
    compact() {
      onSessionEvent(session, {
        type: "user/message",
        data: {
          id: `compaction-${turn}-${step}`,
          role: "user",
          content: [{ type: "text", text: "sanitized checkpoint" }],
          source: { kind: "plugin", plugin: "dsh-compaction-basic" },
        },
        surfaceOp: { op: "replace", start: 1, end: 2 },
      });
    },
    setVersion(file, version) {
      versions.set(path.resolve(session.header.cwd, file), version);
    },
    feed(text, sizes = [text.length], type = "reasoning-delta") {
      let offset = 0;
      let index = 0;
      while (offset < text.length) {
        const size = sizes[index % sizes.length];
        const chunk = text.slice(offset, offset + size);
        onSessionEvent(session, {
          type: "assistant/chunk",
          data: { chunk: { type, index: 0, text: chunk } },
        });
        offset += chunk.length;
        index += 1;
      }
    },
    end(reason = { kind: "completed" }) {
      onSessionEvent(session, { type: "turn/end", data: { turn, reason } });
    },
  };
}

function uniqueCodePrelude(lines = 48) {
  return Array.from(
    { length: lines },
    (_, index) => `const sidebar_value_${String(index).padStart(3, "0")} = ${index * 7919 + 17}; // unique setup ${index}\n`,
  ).join("");
}

function fixedBlock(label, length = 64) {
  let output = `${label}:`;
  let state = [...label].reduce((total, character) => total + character.codePointAt(0), 1);
  while (output.length < length) {
    state = (state * 48271) % 2147483647;
    output += String.fromCharCode(97 + (state % 26));
  }
  return output.slice(0, length);
}

function punctuationBlock(label, length = 64) {
  const alphabet = "=*-_~#.+:;|/\\`^";
  let output = "";
  let state = [...label].reduce((total, character) => total + character.codePointAt(0), 1);
  while (output.length < length) {
    state = (state * 48271) % 2147483647;
    output += alphabet[state % alphabet.length];
  }
  return output;
}

test("generated plugin ignores the exact resizable-sidebar separator across reasoning chunks", async () => {
  const { apply } = await loadGeneratedPlugin();
  const harness = contractHarness(apply);
  const separator = "/* ===== Resizable sidebar =================================================";
  harness.feed(`${uniqueCodePrelude()}${separator}`, [1, 7, 2, 31, 5, 64, 3, 11]);
  assert.deepEqual(harness.steers, []);
  assert.deepEqual(harness.cancels, []);
  assert.deepEqual(harness.warnings, []);
  assert.deepEqual(harness.errors, []);
});

test("formatting punctuation, Markdown rules, and code-comment separators never trigger", async () => {
  const { apply } = await loadGeneratedPlugin();
  const cases = [
    "=".repeat(256),
    "-".repeat(256),
    "*".repeat(256),
    "_".repeat(256),
    "#".repeat(256),
    "~".repeat(256),
    "─".repeat(256),
    "a".repeat(256),
    "1".repeat(256),
    `${"---\n".repeat(48)}${"***\n".repeat(48)}${"___\n".repeat(48)}`,
    `/* ${"=".repeat(96)} */\n// ${"-".repeat(96)}\n# ${"*".repeat(96)}`,
  ];

  for (const [index, value] of cases.entries()) {
    const harness = contractHarness(apply);
    harness.feed(`${uniqueCodePrelude()}${value}`, [13, 1, 55, 2, 8, 3]);
    assert.equal(harness.steers.length, 0, `case ${index} steered`);
    assert.equal(harness.cancels.length, 0, `case ${index} cancelled`);
  }
});

test("low-information blocks cannot trigger the n-gram or large-scale paths", async () => {
  const { apply } = await loadGeneratedPlugin();
  const repeated = punctuationBlock("repeated-punctuation");
  const ngramHarness = contractHarness(apply, { minLen: 128 });
  ngramHarness.feed([
    repeated,
    punctuationBlock("unique-punctuation-bravo"),
    repeated,
    punctuationBlock("unique-punctuation-charlie"),
    repeated,
  ].join(""));
  assert.deepEqual(ngramHarness.steers, []);
  assert.deepEqual(ngramHarness.cancels, []);

  const largeScaleHarness = contractHarness(apply);
  const half = Array.from({ length: 8 }, (_, index) => punctuationBlock(`large-punctuation-${index}`)).join("");
  largeScaleHarness.feed(half + half);
  assert.deepEqual(largeScaleHarness.steers, []);
  assert.deepEqual(largeScaleHarness.cancels, []);
});

test("a false positive consumes no retry before genuine semantic loops steer then cancel", async () => {
  const { apply } = await loadGeneratedPlugin();
  const harness = contractHarness(apply);
  harness.feed(`${uniqueCodePrelude()}/* ===== Resizable sidebar =================================================`, [17, 4, 1, 73]);
  assert.deepEqual(harness.steers, []);
  assert.deepEqual(harness.cancels, []);

  const semanticLoop = `${uniqueCodePrelude(12)}${"repeat this semantic phrase; ".repeat(4)}`;
  harness.feed(semanticLoop, [semanticLoop.length]);
  assert.equal(harness.steers.length, 1);
  assert.equal(harness.cancels.length, 0);
  assert.match(harness.warnings[0], /periodic repeat: period=29/);

  harness.feed(semanticLoop, [2, 1, 89, 5, 34, 3]);
  assert.equal(harness.steers.length, 1);
  assert.deepEqual(harness.cancels, [{ kind: "hook", reason: "loop-detected: periodic repeat: period=29" }]);
});

test("semantic periodic detection is invariant across arbitrary chunk boundaries", async () => {
  const { apply } = await loadGeneratedPlugin();
  const text = `${uniqueCodePrelude(12)}${"meaningful repeated language. ".repeat(4)}`;
  for (const sizes of [[text.length], [1], [1, 2, 3, 5, 8, 13, 21, 34], [127, 9, 64, 3]]) {
    const harness = contractHarness(apply);
    harness.feed(text, sizes);
    assert.equal(harness.steers.length, 1, `chunk plan ${sizes.join(",")} missed the loop`);
    assert.equal(harness.cancels.length, 0);
  }
});

test("semantic 64-character n-gram detection remains functional", async () => {
  const { apply } = await loadGeneratedPlugin();
  const harness = contractHarness(apply);
  const repeated = fixedBlock("semantic-ngram-alpha");
  const text = [
    fixedBlock("unique-ngram-prefix-0"),
    fixedBlock("unique-ngram-prefix-1"),
    fixedBlock("unique-ngram-prefix-2"),
    fixedBlock("unique-ngram-prefix-3"),
    repeated,
    fixedBlock("unique-ngram-bravo"),
    repeated,
    fixedBlock("unique-ngram-charlie"),
    repeated,
  ].join("");
  harness.feed(text);
  assert.equal(harness.steers.length, 1);
  assert.match(harness.warnings[0], /n-gram repeat: 64-char block seen 3x/);
});

test("genuine large-scale repeated output remains functional", async () => {
  const { apply } = await loadGeneratedPlugin();
  const harness = contractHarness(apply);
  const half = Array.from({ length: 8 }, (_, index) => fixedBlock(`large-scale-${index}`)).join("");
  assert.equal(half.length, 512);
  harness.feed(half + half);
  assert.equal(harness.steers.length, 1);
  assert.match(harness.warnings[0], /large-scale repeat: 512 chars repeated 2x\+/);
});

test("sanitized incident replay is redirected at four reads and stopped before a ninth read", async () => {
  const { apply } = await loadGeneratedPlugin();
  const harness = contractHarness(apply, { minLen: 10000 });
  harness.begin("Implement the requested source-code fix and run its tests.");
  await harness.preStep();

  for (let index = 1; index <= 4; index += 1) {
    const call = await harness.tool("read", { file_path: `src/module-${index}.js`, offset: 1, limit: 100 });
    assert.equal(call.dispatched, true);
  }
  const correction = await harness.preStep();
  assert.equal(correction.messages.length, 1);
  assert.match(correction.messages[0].content[0].text, /consecutive_read_only=4/);
  assert.match(correction.messages[0].content[0].text, /concrete edit\/write\/test/);
  assert.equal(correction.messages[0].source.kind, "plugin");

  for (let index = 5; index <= 7; index += 1) {
    const call = await harness.tool("read", { file_path: `src/module-${index}.js`, offset: 1, limit: 100 });
    assert.equal(call.dispatched, true);
  }
  const eighth = await harness.tool("read", { file_path: "src/module-8.js", offset: 1, limit: 100 });
  assert.equal(eighth.dispatched, false, "the eighth read must be stopped before dispatch");
  assert.equal(harness.executions.length, 7);
  assert.equal(harness.cancels.length, 1);
  assert.match(harness.cancels[0].reason, /guard=read_only_hard_limit/);
  assert.match(harness.cancels[0].reason, /No implementation occurred/);
  assert.match(harness.cancels[0].reason, /action 8 was blocked before tool dispatch/);
});

test("first semantic duplicate is suppressed and an immediate retry terminates", async () => {
  const { apply } = await loadGeneratedPlugin();
  const harness = contractHarness(apply, { minLen: 10000 });
  harness.begin("Diagnose the behavior without changing files.");
  await harness.preStep();

  const first = await harness.tool("read", { file_path: "src/app.js" });
  assert.equal(first.dispatched, true);
  const duplicate = await harness.tool("read", {
    file_path: "./src/app.js",
    offset: 1,
    limit: 2000,
  });
  assert.equal(duplicate.dispatched, false);
  assert.equal(duplicate.result.isError, true);
  assert.equal(duplicate.result.error.info.code, "DUPLICATE_READ_SUPPRESSED");
  assert.match(duplicate.result.content[0].text, /^duplicate_read_suppressed:/);
  assert.equal(harness.cancels.length, 0);

  const repeated = await harness.tool("read", { file_path: "/workspace/src/app.js" });
  assert.equal(repeated.dispatched, false);
  assert.equal(repeated.result.error.info.code, "SEMANTIC_DUPLICATE_READ_LOOP");
  assert.equal(harness.cancels.length, 1);
  assert.match(harness.cancels[0].reason, /guard=duplicate_read_repeated/);
});

test("a successful edit or observed file-state change permits the same read again", async () => {
  const { apply } = await loadGeneratedPlugin();
  const harness = contractHarness(apply, { minLen: 10000 });
  harness.begin("Fix src/app.js and verify the change.");
  await harness.preStep();

  assert.equal((await harness.tool("read", { file_path: "src/app.js" })).dispatched, true);
  assert.equal((await harness.tool("str_replace_editor", {
    command: "str_replace",
    path: "/workspace/src/app.js",
    old_str: "old",
    new_str: "new",
  }, { isError: false, value: "updated", content: [{ type: "text", text: "updated" }] })).dispatched, true);
  assert.equal((await harness.tool("read", { file_path: "src/app.js" })).dispatched, true);

  harness.setVersion("src/app.js", "v2");
  assert.equal((await harness.tool("read", { file_path: "src/app.js" })).dispatched, true);
  assert.deepEqual(harness.cancels, []);
});

test("four-read correction and eight-read termination retain state across compaction", async () => {
  const { apply } = await loadGeneratedPlugin();
  const harness = contractHarness(apply, { minLen: 10000 });
  harness.begin("Implement a parser update after inspecting the relevant modules.");
  await harness.preStep();

  for (let index = 1; index <= 4; index += 1) {
    await harness.tool(index % 2 === 0 ? "grep" : "read", index % 2 === 0
      ? { pattern: `symbol_${index}`, path: "src" }
      : { file_path: `src/file-${index}.ts`, offset: 1, limit: 80 });
  }
  harness.compact();
  const afterCompaction = await harness.preStep();
  assert.equal(afterCompaction.messages.length, 2);
  assert.match(afterCompaction.messages[0].content[0].text, /Compaction preserved/);
  assert.match(afterCompaction.messages[0].content[0].text, /no implementation has occurred/);
  assert.match(afterCompaction.messages[1].content[0].text, /consecutive_read_only=4/);

  for (let index = 5; index <= 7; index += 1) {
    await harness.tool("glob", { pattern: `**/*-${index}.ts`, path: "src" });
  }
  const stopped = await harness.tool("read", { file_path: "src/eighth.ts", offset: 1, limit: 80 });
  assert.equal(stopped.dispatched, false);
  assert.match(harness.cancels[0].reason, /consecutive_read_only=8/);
});

test("alternating reads, searches, and harmless shell actions cannot bypass continuation bound", async () => {
  const { apply } = await loadGeneratedPlugin();
  const harness = contractHarness(apply, { minLen: 10000 });
  harness.begin("Implement the missing behavior and run tests.");
  await harness.preStep();

  const tools = [
    (index) => ["read", { file_path: `src/read-${index}.ts`, offset: 1, limit: 40 }],
    (index) => ["glob", { pattern: `**/*-${index}.ts`, path: "src" }],
    (index) => ["grep", { pattern: `unique_${index}`, path: "src" }],
    () => ["bash", { command: "pwd" }, { isError: false, value: "/workspace", content: [] }],
  ];
  for (let index = 1; index <= 24; index += 1) {
    harness.continuation(`Unique reasoning prefix ${index} ${fixedBlock(`continuation-${index}`, 180)}`);
    if (index === 24) break;
    const [name, args, result] = tools[(index - 1) % tools.length](index);
    await harness.tool(name, args, result);
    await harness.preStep();
  }

  assert.equal(harness.cancels.length, 1);
  assert.match(harness.cancels[0].reason, /guard=continuation_hard_limit/);
  assert.match(harness.cancels[0].reason, /24 model continuations/);
  assert.ok(harness.warnings.some((entry) => /injected semantic progress correction/.test(entry)));
});

test("reasoning-prefix second and third occurrence behavior survives compaction without plaintext telemetry", async () => {
  const { apply } = await loadGeneratedPlugin();
  const harness = contractHarness(apply, { minLen: 10000 });
  harness.begin("Diagnose the issue without editing or changing files.");
  await harness.preStep();
  const secretPrefix = `PRIVATE-REASONING-MARKER ${fixedBlock("reasoning-cycle", 220)}`;

  harness.continuation(secretPrefix, [1, 7, 13, 2, 31]);
  harness.compact();
  const compactionFact = await harness.preStep();
  assert.match(compactionFact.messages[0].content[0].text, /Compaction preserved/);
  harness.continuation(secretPrefix, [17, 3, 1, 64]);
  const correction = await harness.preStep();
  assert.ok(correction.messages.some((message) => /reasoning_prefix_occurrence_2/.test(message.content[0].text)));
  assert.equal(harness.cancels.length, 0);

  harness.continuation(secretPrefix);
  assert.equal(harness.cancels.length, 1);
  assert.match(harness.cancels[0].reason, /guard=reasoning_prefix_cycle/);
  assert.match(harness.cancels[0].reason, /only hashes were retained/);
  assert.doesNotMatch([...harness.warnings, ...harness.errors].join("\n"), /PRIVATE-REASONING-MARKER/);
});

test("normal implementation reads, edits, and a new test result complete without containment", async () => {
  const { apply } = await loadGeneratedPlugin();
  const harness = contractHarness(apply, { minLen: 10000 });
  harness.begin("Implement the validation fix, edit the source, and test it.");
  await harness.preStep();

  for (const file of ["src/a.js", "src/b.js", "test/a.test.js"]) {
    assert.equal((await harness.tool("read", { file_path: file, offset: 1, limit: 120 })).dispatched, true);
  }
  assert.equal((await harness.tool("str_replace_editor", {
    command: "insert",
    path: "/workspace/src/a.js",
    insert_line: 3,
    new_str: "const fixed = true;",
  }, { isError: false, value: "updated", content: [] })).dispatched, true);
  assert.equal((await harness.tool("read", { file_path: "src/a.js", offset: 1, limit: 120 })).dispatched, true);
  assert.equal((await harness.tool("bash", { command: "npm test" }, {
    isError: false,
    value: "tests passed",
    content: [{ type: "text", text: "12 tests passed" }],
  })).dispatched, true);
  harness.continuation(`Final verification ${fixedBlock("normal-final", 180)}`);

  assert.deepEqual(harness.cancels, []);
  assert.equal(harness.executions.length, 6);
});

test("legitimate read-only diagnosis is not forced to edit or capped by implementation bounds", async () => {
  const { apply } = await loadGeneratedPlugin();
  const harness = contractHarness(apply, { minLen: 10000 });
  harness.begin("Read-only diagnosis: analyze the failure and do not edit or change any files.");
  await harness.preStep();

  for (let index = 1; index <= 10; index += 1) {
    const call = await harness.tool("read", { file_path: `logs/part-${index}.txt`, offset: 1, limit: 50 });
    assert.equal(call.dispatched, true);
  }
  for (let index = 1; index <= 25; index += 1) {
    harness.continuation(`Diagnosis branch ${index} ${fixedBlock(`diagnosis-${index}`, 180)}`);
  }
  assert.deepEqual(harness.cancels, []);
  assert.equal(harness.executions.length, 10);
});

test("production profile exposes the centrally configured semantic thresholds and effective read defaults", async () => {
  const loopPatch = await readFile(path.join(projectRoot, "seed/profile/patches/dsh-loop-detector@1.0.0.patch"), "utf8");
  assert.match(loopPatch, /export const inject = \['agents', 'fs', 'tools'\]/);
  const profile = await readFile(path.join(projectRoot, "seed/profile/cordis.patch.yml"), "utf8");
  for (const marker of [
    "readOnlyDirective: 4",
    "readOnlyHard: 8",
    "continuationDirective: 12",
    "continuationHard: 24",
    "reasoningPrefixChars: 128",
    "reasoningDirectiveOccurrence: 2",
    "reasoningHardOccurrence: 3",
    "readDefaultOffset: 1",
    "readDefaultLimit: 2000",
  ]) {
    assert.match(profile, new RegExp(marker));
  }
});
