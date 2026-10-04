import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { isPatched, marker, patchSource } from '../scripts/patch-dsh-session-title-reasoning.mjs';

// Verbatim @deepseek-ai/dsh-session-title-llm@0.2.0-rc.2 lib/index.js (MIT;
// license alongside). The patch must keep applying to the pinned release.
const fixture = await readFile(new URL('./fixtures/dsh-session-title-llm-0.2.0-rc.2.js', import.meta.url), 'utf8');

// Execute the patched module with its five package imports replaced by stubs.
async function loadPatched() {
  const patched = patchSource(fixture);
  const lines = patched.split('\n');
  const imports = lines.filter((line) => line.startsWith('import '));
  assert.equal(imports.length, 5, 'pinned imports changed');
  const stubs = `
const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain });
const z = chain;
class BlockAssembler {
  finish = undefined;
  parts = [];
  push(chunk) {
    if (chunk.type === 'text') this.parts.push({ type: 'text', text: chunk.text });
    if (chunk.type === 'finish') this.finish = chunk.finish;
  }
  blocks() { return this.parts; }
}
const createUserMessage = (message) => ({ role: 'user', ...message });
const MAX_TIMER_DELAY_MS = 2147483647;
const deadline = (signal, ms) => ({ signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]), [Symbol.dispose]() {} });
const deepFreeze = (value) => Object.freeze(value);
const SessionTitleProviderId = (id) => id;
const normalizeSessionTitle = (title) => title.trim();
`;
  const body = lines.filter((line) => !line.startsWith('import ')).join('\n');
  return import(`data:text/javascript,${encodeURIComponent(stubs + body)}`);
}

function harness(efforts, { resolveError } = {}) {
  const calls = [];
  const appended = [];
  const ctx = {
    llm: {
      async resolveModelInfo(provider, model) {
        if (resolveError) throw resolveError;
        return { provider, id: model, ...(efforts === undefined ? {} : { reasoning: { efforts: efforts.map((id) => ({ id, name: id })) } }) };
      },
      async *stream(options) {
        calls.push(options);
        yield { type: 'text', text: 'Session naming plugins' };
        yield { type: 'finish', finish: { kind: 'stop' } };
      },
    },
  };
  const request = {
    signal: new AbortController().signal,
    route: { provider: 'local-ollama', model: 'local-active' },
    session: { id: 'session-1', append: (type, data) => appended.push({ type, data }) },
  };
  return { ctx, request, calls, appended };
}

const config = { targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096, maxOutputTokens: 64, timeoutMs: 600000 };
const selected = [{ seq: 3, text: 'is there a plugin for automatically naming sessions?' }];

test('title requests disable reasoning when the route offers off', async () => {
  const { generateSessionTitleWithLlm } = await loadPatched();
  const { ctx, request, calls, appended } = harness(['off', 'low', 'medium', 'xhigh']);
  const result = await generateSessionTitleWithLlm(ctx, config, request, selected, 'first-prompt');
  assert.equal(result.title, 'Session naming plugins');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reasoningEffort, 'off');
  assert.equal(calls[0].maxTokens, 64);
  assert.equal(calls[0].purpose, 'session-title');
  // The durable request record keeps its upstream schema.
  assert.equal(appended[0].type, 'session/title-llm-request');
  assert.equal('reasoningEffort' in appended[0].data, false);
});

test('title requests keep the upstream shape for routes without off', async () => {
  const { generateSessionTitleWithLlm } = await loadPatched();
  for (const efforts of [undefined, ['low', 'medium']]) {
    const { ctx, request, calls } = harness(efforts);
    await generateSessionTitleWithLlm(ctx, config, request, selected, 'first-prompt');
    assert.equal('reasoningEffort' in calls[0], false);
  }
});

test('an unresolvable model keeps the upstream request instead of failing the title', async () => {
  const { generateSessionTitleWithLlm } = await loadPatched();
  const { ctx, request, calls } = harness(['off'], { resolveError: new Error('catalog unavailable') });
  await generateSessionTitleWithLlm(ctx, config, request, selected, 'first-prompt');
  assert.equal('reasoningEffort' in calls[0], false);
});

test('session-title patch is idempotent and fails closed on drift', () => {
  const once = patchSource(fixture);
  assert.ok(once.includes(marker));
  assert.ok(isPatched(once));
  assert.equal(patchSource(once), once);
  assert.equal(isPatched(fixture), false);
  assert.throws(() => patchSource('different upstream'), /source drift/);
  assert.throws(() => patchSource(fixture.replace('maxTokens: config.maxOutputTokens,', 'maxTokens: 1,')), /source drift/);
});
