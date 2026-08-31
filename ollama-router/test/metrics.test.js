import test from 'node:test';
import assert from 'node:assert/strict';
import { Metrics } from '../src/metrics.js';

test('metrics aggregates requests and usage', () => {
  const metrics = new Metrics();
  metrics.recordRequest({
    method: 'POST',
    endpoint: '/api/chat',
    requestedModel: 'active:model',
    clientIdentity: 'open-webui',
    responseStatus: 200,
    allowed: true,
    latencyMs: 100,
    keepAliveNormalized: true,
    usage: {
      prompt_eval_count: 5,
      eval_count: 10,
      eval_duration: 1_000_000_000,
      eval_tokens_per_second: 10
    }
  });
  metrics.recordRequest({
    method: 'POST',
    endpoint: '/api/chat',
    requestedModel: 'other:model',
    clientIdentity: 'comfyui',
    responseStatus: 409,
    rejected: true,
    latencyMs: 5
  });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.totalRequests, 2);
  assert.equal(snapshot.keepAliveNormalizations, 1);
  assert.equal(snapshot.rejectedRequests, 1);
  assert.equal(snapshot.tokens.prompt, 5);
  assert.equal(snapshot.tokens.output, 10);
  assert.equal(snapshot.throughput.evalTokensPerSecondAvg, 10);
});
