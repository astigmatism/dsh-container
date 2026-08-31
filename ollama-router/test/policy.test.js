import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { evaluateProxyPolicy } from '../src/policy.js';

function config(overrides = {}) {
  return loadConfig({
    OLLAMA_UPSTREAM_URL: 'http://ollama:11434',
    ACTIVE_MODEL: 'active:model',
    ACTIVE_MODEL_FILE: '/tmp/missing-active-model.json',
    ADMIN_TOKEN: '',
    ...overrides
  });
}

test('active chat request without keep_alive is allowed and rewritten', () => {
  const result = evaluateProxyPolicy({
    method: 'POST',
    pathname: '/api/chat',
    body: { model: 'active:model', messages: [], stream: false },
    activeModelInfo: { model: 'active:model' },
    config: config()
  });
  assert.equal(result.allowed, true);
  assert.equal(result.sanitizedBody.keep_alive, -1);
  assert.equal(result.keepAliveNormalized, true);
});

test('active generate request with finite keep_alive is overwritten', () => {
  const result = evaluateProxyPolicy({
    method: 'POST',
    pathname: '/api/generate',
    body: { model: 'active:model', prompt: 'hi', keep_alive: '5m' },
    activeModelInfo: { model: 'active:model' },
    config: config()
  });
  assert.equal(result.allowed, true);
  assert.equal(result.incomingKeepAlive, '5m');
  assert.equal(result.forwardedKeepAlive, -1);
  assert.equal(result.sanitizedBody.keep_alive, -1);
});

test('non-active model is rejected by default', () => {
  const result = evaluateProxyPolicy({
    method: 'POST',
    pathname: '/api/chat',
    body: { model: 'other:model', messages: [] },
    activeModelInfo: { model: 'active:model' },
    config: config()
  });
  assert.equal(result.allowed, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, 'MODEL_NOT_ACTIVE');
});

test('rewrite requested model to active preserves other request parameters', () => {
  const result = evaluateProxyPolicy({
    method: 'POST',
    pathname: '/api/chat',
    body: {
      model: 'open-webui-workflow-base:model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      keep_alive: '5m',
      think: false,
      options: {
        temperature: 0.2,
        num_ctx: 4096
      }
    },
    activeModelInfo: { model: 'active:model' },
    config: config({ REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'true' })
  });

  assert.equal(result.allowed, true);
  assert.equal(result.requestedModel, 'open-webui-workflow-base:model');
  assert.equal(result.forwardedModel, 'active:model');
  assert.equal(result.modelRewritten, true);
  assert.equal(result.sanitizedBody.model, 'active:model');
  assert.equal(result.sanitizedBody.keep_alive, -1);
  assert.equal(result.forwardedKeepAlive, -1);
  assert.deepEqual(result.sanitizedBody.options, {
    temperature: 0.2,
    num_ctx: 4096
  });
  assert.equal(result.sanitizedBody.think, false);
  assert.deepEqual(result.sanitizedBody.messages, [{ role: 'user', content: 'hi' }]);
});

test('rewrite requested model to active also fills missing model', () => {
  const result = evaluateProxyPolicy({
    method: 'POST',
    pathname: '/api/chat',
    body: { messages: [{ role: 'user', content: 'hi' }], stream: false },
    activeModelInfo: { model: 'active:model' },
    config: config({ REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'true' })
  });

  assert.equal(result.allowed, true);
  assert.equal(result.requestedModel, null);
  assert.equal(result.forwardedModel, 'active:model');
  assert.equal(result.modelRewritten, true);
  assert.equal(result.sanitizedBody.model, 'active:model');
  assert.equal(result.sanitizedBody.keep_alive, -1);
});

test('rewrite requested model to active covers model show requests', () => {
  const result = evaluateProxyPolicy({
    method: 'POST',
    pathname: '/api/show',
    body: { model: 'open-webui-workflow-base:model', verbose: true },
    activeModelInfo: { model: 'active:model' },
    config: config({ REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'true' })
  });

  assert.equal(result.allowed, true);
  assert.equal(result.requestedModel, 'open-webui-workflow-base:model');
  assert.equal(result.forwardedModel, 'active:model');
  assert.equal(result.modelRewritten, true);
  assert.equal(result.sanitizedBody.model, 'active:model');
  assert.equal(result.sanitizedBody.verbose, true);
});

test('missing active marker fails closed', () => {
  const result = evaluateProxyPolicy({
    method: 'POST',
    pathname: '/api/chat',
    body: { model: 'any:model', messages: [] },
    activeModelInfo: { model: null },
    config: config({ ACTIVE_MODEL: '' })
  });
  assert.equal(result.allowed, false);
  assert.equal(result.status, 503);
  assert.equal(result.code, 'NO_ACTIVE_MODEL');
});

test('allowlist mode can permit an additional model without active-model keep_alive rewrite', () => {
  const result = evaluateProxyPolicy({
    method: 'POST',
    pathname: '/api/chat',
    body: { model: 'allowed:model', messages: [], keep_alive: '10m' },
    activeModelInfo: { model: 'active:model' },
    config: config({ MODEL_POLICY_MODE: 'allowlist', ALLOWED_MODELS: 'allowed:model' })
  });
  assert.equal(result.allowed, true);
  assert.equal(result.forwardedKeepAlive, '10m');
  assert.equal(result.sanitizedBody.keep_alive, '10m');
});

test('safe status routes are allowed', () => {
  const result = evaluateProxyPolicy({
    method: 'GET',
    pathname: '/api/version',
    body: null,
    activeModelInfo: { model: 'active:model' },
    config: config()
  });
  assert.equal(result.allowed, true);
});
