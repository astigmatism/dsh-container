import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { readActiveModel, writeActiveModelMarker } from '../src/active-model.js';

test('reads active model JSON marker', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-marker-'));
  const file = path.join(dir, 'active-model.json');
  await writeActiveModelMarker(file, { model: 'active:model', profile: 'test', source: 'unit-test' });
  const info = await readActiveModel(loadConfig({ ACTIVE_MODEL_FILE: file, ADMIN_TOKEN: '' }));
  assert.equal(info.model, 'active:model');
  assert.equal(info.profile, 'test');
  assert.equal(info.loadedFrom, 'file');
});

test('falls back to ACTIVE_MODEL when marker missing', async () => {
  const info = await readActiveModel(loadConfig({ ACTIVE_MODEL_FILE: '/tmp/does-not-exist-router-marker.json', ACTIVE_MODEL: 'fallback:model', ADMIN_TOKEN: '' }));
  assert.equal(info.model, 'fallback:model');
  assert.equal(info.loadedFrom, 'env-fallback');
});

test('reads and writes an optional per-model thinking default', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-marker-think-'));
  const file = path.join(dir, 'active-model.json');
  await writeActiveModelMarker(file, {
    model: 'thinking:model',
    profile: 'reasoning',
    default_think: 'medium'
  });
  const info = await readActiveModel(loadConfig({ ACTIVE_MODEL_FILE: file, ADMIN_TOKEN: '' }));
  assert.equal(info.default_think_configured, true);
  assert.equal(info.default_think, 'medium');
});

test('reads and writes model/profile-specific reasoning capabilities', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-marker-reasoning-'));
  const file = path.join(dir, 'active-model.json');
  const supportedThinkLevels = ['low', 'medium'];
  const reasoningEffortMap = {
    minimal: 'low',
    low: 'low',
    medium: 'medium',
    high: true,
    xhigh: true,
    max: true
  };
  await writeActiveModelMarker(file, {
    model: 'thinking:model',
    profile: 'night',
    supported_think_levels: supportedThinkLevels,
    reasoning_effort_map: reasoningEffortMap
  });
  const info = await readActiveModel(loadConfig({ ACTIVE_MODEL_FILE: file, ADMIN_TOKEN: '' }));
  assert.equal(info.reasoning_capabilities_configured, true);
  assert.deepEqual(info.supported_think_levels, supportedThinkLevels);
  assert.deepEqual(info.reasoning_effort_map, reasoningEffortMap);
});
