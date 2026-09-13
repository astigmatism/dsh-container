import assert from 'node:assert/strict';
import test from 'node:test';
import { currentStep, patchSource } from '../scripts/patch-dsh-progress-status.mjs';

test('progress uses the current open turn and its durable step start after reload', () => {
  const timeline = { turns: new Map([
    [1, { status: 'closed', steps: [{ step: 99, start: { time: 1 }, status: 'closed' }] }],
    [2, { status: 'open', steps: [{ step: 3, start: { time: 1000 }, status: 'open' }] }],
  ]) };
  assert.deepEqual(currentStep(timeline), { number: 3, startedAt: 1000, status: 'open' });
  assert.equal(currentStep({ turns: new Map() }), null);
});

test('progress patch fails closed on changed upstream markup', () => {
  assert.throws(() => patchSource('different upstream'), /source drift/);
});
