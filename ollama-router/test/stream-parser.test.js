import test from 'node:test';
import assert from 'node:assert/strict';
import { NdjsonUsageCollector, extractUsageFromOllamaObject } from '../src/stream-parser.js';

test('extracts usage and throughput from final object', () => {
  const usage = extractUsageFromOllamaObject({
    done: true,
    prompt_eval_count: 10,
    prompt_eval_duration: 1_000_000_000,
    eval_count: 20,
    eval_duration: 2_000_000_000,
    total_duration: 3_000_000_000
  });
  assert.equal(usage.eval_tokens_per_second, 10);
  assert.equal(usage.prompt_tokens_per_second, 10);
});

test('NDJSON collector handles split streaming chunks', () => {
  const collector = new NdjsonUsageCollector();
  collector.observe(Buffer.from('{"done":false,"response":"he"}\n{"done":'));
  collector.observe(Buffer.from('true,"eval_count":4,"eval_duration":2000000000}\n'));
  const result = collector.finish();
  assert.equal(result.parseErrors, 0);
  assert.equal(result.usage.eval_count, 4);
  assert.equal(result.usage.eval_tokens_per_second, 2);
});
