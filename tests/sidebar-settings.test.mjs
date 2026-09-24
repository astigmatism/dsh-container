import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { initializeSidebarSettings, missingSidebarDefaults } from '../scripts/initialize-sidebar-settings.mjs';

test('new installation seeds only retained Sidebar tabs', () => {
  const entries = missingSidebarDefaults({ permission: { defaultPreset: 'custom' } });
  assert.equal(entries.length, 2);
  assert.ok(entries.every(entry => !['agentTerminalTools', 'terminal', 'browser'].includes(entry.path.at(-1))));
  assert.ok(entries.some(entry => entry.path.at(-1) === 'sidechat' && entry.value === false));
});

test('recreation preserves explicit choices and unrelated preferences', () => {
  const state = {
    'dsh-better-sidebar': { agentTerminalTools: false, browserInterceptLinks: true,
      tabsEnabled: { terminal: false, subagent: false, sidechat: true, browser: true, custom: false },
      pluginSettings: { custom: { value: 'keep' } } },
    'agent-default-model': { model: 'keep' },
    _meta: { revision: 12 },
  };
  const before = structuredClone(state);
  assert.deepEqual(missingSidebarDefaults(state), []);
  assert.deepEqual(state, before);
});

test('partial preferences receive only absent leaves', () => {
  const missing = missingSidebarDefaults({ 'dsh-better-sidebar': { agentTerminalTools: false, tabsEnabled: { terminal: false } } });
  assert.equal(missing.length, 2);
  assert.ok(missing.every(entry => !['terminal', 'agentTerminalTools'].includes(entry.path.at(-1))));
});

test('malformed settings are rejected without replacing user data', () => {
  for (const state of [null, [], { 'dsh-better-sidebar': null }, { 'dsh-better-sidebar': { tabsEnabled: [] } }]) {
    assert.throws(() => missingSidebarDefaults(state));
  }
});

// The Harness image owns the YAML runtime. The base-Node repository suite
// exercises the pure merge above; --build additionally exercises real files.
const imageTest = process.env.DSH_TEST_HARNESS === '1';
test('atomic initialization preserves YAML, ownership, permissions and later user choices', { skip: !imageTest }, () => {
  const require = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
  const YAML = require('yaml');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-settings-'));
  try {
    const file = path.join(root, 'settings.yaml');
    fs.writeFileSync(file, '# keep this comment\nother:\n  choice: custom\ndsh-better-sidebar:\n  agentTerminalTools: false\n_meta:\n  revision: 17\n', { mode: 0o640 });
    const before = fs.statSync(file);
    assert.equal(initializeSidebarSettings(file, YAML), true);
    const text = fs.readFileSync(file, 'utf8');
    const settings = YAML.parse(text);
    assert.ok(text.startsWith('# keep this comment'));
    assert.deepEqual(settings.other, { choice: 'custom' });
    assert.deepEqual(settings._meta, { revision: 17 });
    assert.equal(settings['dsh-better-sidebar'].agentTerminalTools, false);
    assert.equal(settings['dsh-better-sidebar'].tabsEnabled.sidechat, false);
    const after = fs.statSync(file);
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
    assert.equal(after.mode & 0o777, 0o640);
    assert.equal(initializeSidebarSettings(file, YAML), false);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.equal(fs.statSync(file).ino, after.ino, 'no-op restart does not replace the file');
    fs.symlinkSync(file, path.join(root, 'symlink'));
    assert.throws(() => initializeSidebarSettings(path.join(root, 'symlink'), YAML));
    fs.writeFileSync(file, 'broken: [yaml');
    assert.throws(() => initializeSidebarSettings(file, YAML));
    assert.equal(fs.readFileSync(file, 'utf8'), 'broken: [yaml');
    assert.deepEqual(fs.readdirSync(root).sort(), ['settings.yaml', 'symlink']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
