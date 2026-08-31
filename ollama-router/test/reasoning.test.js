import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isThinkingEnabled,
  parseDefaultThink,
  reasoningEffortToThink,
  resolveDefaultThink,
  thinkLevelToReasoningEffort,
  validateReasoningCapabilities
} from '../src/reasoning.js';

const DAY_REASONING = {
  supported_think_levels: ['low', 'medium', 'high', 'max'],
  reasoning_effort_map: {
    minimal: 'low',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'max',
    max: 'max'
  }
};

const NIGHT_REASONING = {
  supported_think_levels: ['low', 'medium'],
  reasoning_effort_map: {
    minimal: 'low',
    low: 'low',
    medium: 'medium',
    high: true,
    xhigh: true,
    max: true
  }
};

test('maps Ollama think values back to generic reasoning efforts', () => {
  assert.equal(thinkLevelToReasoningEffort(true), 'high');
  assert.equal(thinkLevelToReasoningEffort(false), 'none');
  assert.equal(thinkLevelToReasoningEffort('low'), 'low');
  assert.equal(thinkLevelToReasoningEffort('medium'), 'medium');
  assert.equal(thinkLevelToReasoningEffort('high'), 'high');
  assert.equal(thinkLevelToReasoningEffort('max'), 'max');
  assert.equal(thinkLevelToReasoningEffort('minimal'), 'minimal');
  assert.equal(thinkLevelToReasoningEffort('xhigh'), 'xhigh');
  assert.equal(thinkLevelToReasoningEffort(undefined), undefined);
  assert.equal(thinkLevelToReasoningEffort('invalid'), undefined);
});

test('maps generic reasoning efforts to Ollama think values', () => {
  assert.equal(reasoningEffortToThink('none'), false);
  assert.equal(reasoningEffortToThink('minimal', DAY_REASONING), 'low');
  assert.equal(reasoningEffortToThink('low', DAY_REASONING), 'low');
  assert.equal(reasoningEffortToThink('medium', DAY_REASONING), 'medium');
  assert.equal(reasoningEffortToThink('high', DAY_REASONING), 'high');
  assert.equal(reasoningEffortToThink('xhigh', DAY_REASONING), 'max');
  assert.equal(reasoningEffortToThink('max', DAY_REASONING), 'max');
  assert.equal(reasoningEffortToThink('high', NIGHT_REASONING), true);
  assert.equal(reasoningEffortToThink('xhigh', NIGHT_REASONING), true);
  assert.equal(reasoningEffortToThink('max', NIGHT_REASONING), true);
  assert.equal(reasoningEffortToThink('invalid'), undefined);
});

test('rejects missing, incomplete, and internally inconsistent reasoning profiles', () => {
  assert.throws(
    () => reasoningEffortToThink('high'),
    (error) => error.code === 'MISSING_REASONING_CAPABILITIES'
  );
  assert.throws(
    () => validateReasoningCapabilities({ supported_think_levels: ['low'] }),
    (error) => error.code === 'INVALID_REASONING_CAPABILITIES'
  );
  assert.throws(
    () => validateReasoningCapabilities({
      ...DAY_REASONING,
      reasoning_effort_map: { ...DAY_REASONING.reasoning_effort_map, max: 'xhigh' }
    }),
    (error) => error.code === 'INVALID_REASONING_CAPABILITIES'
  );
  assert.throws(
    () => validateReasoningCapabilities({
      ...NIGHT_REASONING,
      reasoning_effort_map: { ...NIGHT_REASONING.reasoning_effort_map, max: false }
    }),
    (error) => error.code === 'INVALID_REASONING_CAPABILITIES'
  );
  assert.throws(
    () => validateReasoningCapabilities({
      ...NIGHT_REASONING,
      reasoning_effort_map: { ...NIGHT_REASONING.reasoning_effort_map, max: null }
    }),
    (error) => error.code === 'INVALID_REASONING_CAPABILITIES'
  );
});

test('parses boolean, level, compatibility, and model-default settings', () => {
  assert.equal(parseDefaultThink(true), true);
  assert.equal(parseDefaultThink('false'), false);
  assert.equal(parseDefaultThink('none'), false);
  assert.equal(parseDefaultThink('minimal'), 'minimal');
  assert.equal(parseDefaultThink('xhigh'), 'xhigh');
  assert.equal(parseDefaultThink('max'), 'max');
  assert.equal(parseDefaultThink('model-default'), undefined);
  assert.throws(() => parseDefaultThink('turbo'), /thinking default/);
});

test('resolves active-model defaults before global defaults and endpoint fallbacks', () => {
  const config = { defaultThinkConfigured: true, defaultThink: 'medium' };
  assert.equal(resolveDefaultThink({ default_think_configured: true, default_think: 'xhigh' }, config, false), 'xhigh');
  assert.equal(resolveDefaultThink({ default_think_configured: false }, config, false), 'medium');
  assert.equal(resolveDefaultThink({ default_think_configured: false }, { defaultThinkConfigured: false }, false), false);
  assert.equal(resolveDefaultThink({ default_think_configured: false }, { defaultThinkConfigured: false }), undefined);
  assert.equal(isThinkingEnabled('max'), true);
  assert.equal(isThinkingEnabled(false), false);
});
