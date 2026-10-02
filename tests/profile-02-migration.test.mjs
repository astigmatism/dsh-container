import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { migrate } from '../scripts/migrate-harness-02-profile.mjs';
let YAML;
try { YAML = createRequire(`${process.env.DSH_RUNTIME_ROOT || '/usr/local/lib/node_modules/@deepseek-ai/dsh'}/package.json`)('yaml'); } catch {}
function fixture(t, patch, fresh = false) {
  const home = fs.mkdtempSync(os.tmpdir() + '/profile-02-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(home + '/profiles/web', { recursive: true });
  fs.writeFileSync(home + '/profiles/web/package.json', JSON.stringify({ dsh: { profile: { bundles: ['dsh-playwright', 'dsh-context'] } }, ...(fresh ? { dshContainer: {} } : {}) }));
  fs.writeFileSync(home + '/profiles/web/cordis.patch.yml', patch);
  return home;
}
test('upgrade preserves other settings, archives old browser preferences and activates only previously enabled Schedule', { skip: !YAML }, t => {
  for (const enabled of [true, false]) {
    const input = `- id: schedule\n  disabled: ${!enabled}\n- id: dsh-playwright\n  disabled: true\n  config:\n    viewportWidth: 1500\n- id: ui-chat\n  config:\n    transcriptView: normal\n- id: session-pin\n  config:\n    pins: [fixture-session]\n- id: custom\n  disabled: !!js process.env.FIXTURE === '1'\n`;
    const home = fixture(t, input);
    assert.equal(migrate(home, YAML), true);
    const source = fs.readFileSync(home + '/profiles/web/cordis.patch.yml', 'utf8');
    assert.match(source, /transcriptView: standard/); assert.match(source, /pins: \[ fixture-session \]|fixture-session/); assert.match(source, /!!js/);
    assert.match(source, /id: ego-browser\n  disabled: true/); assert.doesNotMatch(source, /viewportWidth|dsh-playwright/);
    assert.equal(JSON.parse(fs.readFileSync(home + '/profiles/web/package.json')).dsh.profile.bundles.includes('@deepseek-ai/dsh-experimental-schedule-bundle'), enabled);
    assert.ok(fs.readdirSync(home + '/profile-before-02').some(file => fs.readFileSync(home + '/profile-before-02/' + file, 'utf8') === input));
    assert.equal(migrate(home, YAML), false); assert.equal(fs.readFileSync(home + '/profiles/web/cordis.patch.yml', 'utf8'), source);
    // Simulate process death after publication but before committing the receipt.
    fs.renameSync(home + '/.container-profile-02.json', home + '/.container-profile-02.json.pending');
    assert.equal(migrate(home, YAML), true);
  }
});
test('fresh settings and explicit presentation modes are retained; unsafe paths fail closed', { skip: !YAML }, t => {
  const fresh = fixture(t, '[]\n', true); assert.equal(migrate(fresh, YAML), false);
  assert.equal(fs.readFileSync(fresh + '/profiles/web/cordis.patch.yml', 'utf8'), '[]\n');
  const explicit = fixture(t, '- id: ui-chat\n  config:\n    transcriptView: detailed\n'); migrate(explicit, YAML);
  assert.match(fs.readFileSync(explicit + '/profiles/web/cordis.patch.yml', 'utf8'), /transcriptView: detailed/);
  const unsafe = fixture(t, '[]\n'); fs.renameSync(unsafe + '/profiles/web', unsafe + '/outside'); fs.symlinkSync(unsafe + '/outside', unsafe + '/profiles/web');
  assert.throws(() => migrate(unsafe, YAML), /symlinked/);
});
