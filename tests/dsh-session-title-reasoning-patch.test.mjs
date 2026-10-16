import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { marker, verifyGenerator, verifyProvider } from '../scripts/patch-dsh-session-title-reasoning.mjs';

// Verbatim @deepseek-ai/dsh-session-title-llm@0.2.1-alpha.5 lib/index.js
// (MIT; license alongside). The build gate must keep passing on the pinned
// release and fail when upstream drops the least-effort title selection.
const fixture = await readFile(new URL('./fixtures/dsh-session-title-llm-0.2.1-alpha.5.js', import.meta.url), 'utf8');

const providerSelector = 'const selectReasoningEffort = (model) => model.reasoning?.efforts[0]?.id;';

test('the pinned generator selects the least reasoning effort for title calls', () => {
  verifyGenerator(fixture);
  assert.match(fixture, /const effort = prepared\.selectReasoningEffort\(model\);/);
  assert.match(fixture, /\.\.\.effort === void 0 \? \{\} : \{ reasoningEffort: effort \}/);
});

test('the pinned providers select the first advertised effort', () => {
  verifyProvider(providerSelector);
  assert.match(providerSelector, /efforts\[0\]\?\.id/);
});

test('upstream drift fails closed', () => {
  assert.throws(() => verifyGenerator(fixture.replace('const effort = prepared.selectReasoningEffort(model);', 'const effort = void 0;')), /upstream drift/);
  assert.throws(() => verifyGenerator(fixture.replace('...effort === void 0 ? {} : { reasoningEffort: effort }', '')), /upstream drift/);
  assert.throws(() => verifyProvider('const selectReasoningEffort = () => void 0;'), /selector changed/);
  assert.throws(() => verifyGenerator('different upstream'), /upstream drift/);
});

test('the marker documents the upstreamed behavior', () => {
  assert.equal(marker, 'dsh-session-title-reasoning-off-v1');
});
