import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { migrateProfile } from '../scripts/migrate-profile-settings.mjs';
let YAML;
try { YAML = createRequire(`${process.env.DSH_RUNTIME_ROOT ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh'}/package.json`)('yaml'); } catch {}
const defaults = new URL('../config/', import.meta.url).pathname;
function fixture(t, settings, patch) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-migrate-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(`${home}/profiles/web`, { recursive: true });
  fs.writeFileSync(`${home}/settings.yaml`, YAML.stringify(settings));
  fs.writeFileSync(`${home}/profiles/web/cordis.patch.yml`, patch);
  return home;
}
test('legacy settings preserve explicit values, archive inputs and leave future edits alone', { skip: !YAML }, t => {
  const baseline = fs.readFileSync(`${defaults}/legacy-profile-alpha1.yaml`, 'utf8');
  const settings = {
    'agent-default-model': { provider: 'local-everyday', model: 'qwen3.8-27b-abliterated-q6_k', reasoningEffort: 'off' },
    'llm-pi-ai': { providers: { 'local-everyday': { apiKeyEnv: 'FIXTURE_KEY', maxConcurrency: 1, models: [{ id: 'fixture', maxTokens: null }] } } },
    'dsh-better-sidebar': { agentTerminalTools: true, autoOpenJobs: false, tabsEnabled: { terminal: true, browser: false, subagent: false } },
    'session-pin': { pins: [] },
    'ui-onboarding': { welcomeNoticeVersion: 'fixture' },
    'agent-preset-registry': { default: 'minimal' },
  };
  const home = fixture(t, settings, baseline);
  assert.equal(migrateProfile(home, defaults, YAML), true);
  const file = `${home}/profiles/web/cordis.patch.yml`;
  const result = Object.fromEntries(YAML.parse(fs.readFileSync(file, 'utf8')).map(row => [row.id, row.config]));
  assert.deepEqual(result['llm-pi-ai'], settings['llm-pi-ai']);
  assert.deepEqual(result['agent-default-model'], settings['agent-default-model']);
  assert.deepEqual(result['better-sidebar'], { autoOpenJobs: false, tabsEnabled: { subagent: false } });
  assert.deepEqual(result['session-pin'], { pins: [] });
  assert.equal(result['agent-preset-registry'].default, 'minimal');
  assert.ok(!fs.existsSync(`${home}/settings.yaml`));
  assert.deepEqual(YAML.parse(fs.readFileSync(`${home}/settings.yaml.imported`, 'utf8')), settings);
  assert.equal(fs.readFileSync(`${home}/profile-before-0.1.7.yaml`, 'utf8'), baseline);
  const edited = '- id: ui-theme\n  config:\n    theme: dark\n';
  fs.writeFileSync(file, edited);
  for (let i = 0; i < 2; i++) {
    assert.equal(migrateProfile(home, defaults, YAML), false);
    assert.equal(fs.readFileSync(file, 'utf8'), edited);
  }
});
test('explicit profile overrides and JS tags survive baseline extraction', { skip: !YAML }, t => {
  const home = fixture(t, { 'agent-default-model': { reasoningEffort: 'medium' } },
    '- id: agent-default-model\n  config:\n    reasoningEffort: off\n- insert:\n    - id: custom\n      name: custom-plugin\n      disabled: !!js process.env.DISABLED === "true"\n');
  migrateProfile(home, defaults, YAML);
  const source = fs.readFileSync(`${home}/profiles/web/cordis.patch.yml`, 'utf8');
  assert.match(source, /reasoningEffort: off/);
  assert.match(source, /!!js/);
  assert.match(source, /custom-plugin/);
});
test('nested profile preferences retain legacy credential references and sibling providers', { skip: !YAML }, t => {
  const home = fixture(t, { 'llm-pi-ai': { providers: {
    first: { apiKeyEnv: 'FIXTURE_KEY', maxConcurrency: 1 }, second: { apiKeyEnv: 'SECOND_KEY' },
  } } }, '- id: llm-pi-ai\n  config:\n    providers:\n      first:\n        maxConcurrency: 2\n');
  migrateProfile(home, defaults, YAML);
  const [row] = YAML.parse(fs.readFileSync(`${home}/profiles/web/cordis.patch.yml`, 'utf8'));
  assert.deepEqual(row.config.providers, {
    first: { apiKeyEnv: 'FIXTURE_KEY', maxConcurrency: 2 }, second: { apiKeyEnv: 'SECOND_KEY' },
  });
});
test('malformed active settings stop before any input changes', { skip: !YAML }, t => {
  const home = fixture(t, { 'llm-pi-ai': 'invalid' }, '[]\n');
  const before = fs.readFileSync(`${home}/settings.yaml`, 'utf8');
  assert.throws(() => migrateProfile(home, defaults, YAML), /must be a mapping/);
  assert.equal(fs.readFileSync(`${home}/settings.yaml`, 'utf8'), before);
  assert.equal(fs.readFileSync(`${home}/profiles/web/cordis.patch.yml`, 'utf8'), '[]\n');
  assert.ok(!fs.existsSync(`${home}/.container-settings-v1.json`));
});
test('interrupted archive publication resumes without replacing the archive or reimporting defaults', { skip: !YAML }, t => {
  const home = fixture(t, { 'agent-default-model': { reasoningEffort: 'off' } }, '[]\n');
  migrateProfile(home, defaults, YAML);
  const file = `${home}/profiles/web/cordis.patch.yml`;
  const saved = fs.readFileSync(file, 'utf8');
  const archive = fs.readFileSync(`${home}/settings.yaml.imported`, 'utf8');
  fs.renameSync(`${home}/.container-settings-v1.json`, `${home}/.container-settings-pending.json`);
  assert.equal(migrateProfile(home, defaults, YAML), false);
  assert.equal(fs.readFileSync(file, 'utf8'), saved);
  assert.equal(fs.readFileSync(`${home}/settings.yaml.imported`, 'utf8'), archive);
  fs.renameSync(`${home}/.container-settings-v1.json`, `${home}/.container-settings-pending.json`);
  fs.writeFileSync(file, '[]\n');
  assert.throws(() => migrateProfile(home, defaults, YAML), /changed/);
  assert.equal(fs.readFileSync(`${home}/settings.yaml.imported`, 'utf8'), archive);
});
test('interruption before profile publication resumes from the prepared document', { skip: !YAML }, t => {
  const home = fixture(t, { 'agent-default-model': { reasoningEffort: 'off' } }, '[]\n');
  migrateProfile(home, defaults, YAML);
  const file = `${home}/profiles/web/cordis.patch.yml`;
  const published = fs.readFileSync(file, 'utf8');
  const receipt = JSON.parse(fs.readFileSync(`${home}/.container-settings-v1.json`));
  fs.writeFileSync(receipt.temporary, published);
  fs.writeFileSync(file, '[]\n');
  fs.renameSync(`${home}/settings.yaml.imported`, `${home}/settings.yaml`);
  fs.renameSync(`${home}/.container-settings-v1.json`, `${home}/.container-settings-pending.json`);
  assert.equal(migrateProfile(home, defaults, YAML), false);
  assert.equal(fs.readFileSync(file, 'utf8'), published);
  assert.ok(!fs.existsSync(receipt.temporary));
  assert.ok(fs.existsSync(`${home}/settings.yaml.imported`));
});
