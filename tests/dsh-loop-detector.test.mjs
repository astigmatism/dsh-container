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
  const session = { id: "contract-session" };
  const agent = {
    steer(message) {
      steers.push(message);
    },
    cancel(reason) {
      cancels.push(reason);
    },
  };
  const ctx = {
    agents: { get: (id) => (String(id) === session.id ? agent : undefined) },
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
  assert.equal(typeof onSessionEvent, "function");

  return {
    steers,
    cancels,
    warnings,
    errors,
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
      onSessionEvent(session, { type: "turn/end", data: { reason } });
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
