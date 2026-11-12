import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { reconcile, RETIRED_BUNDLE, VOICE_BUNDLE, WHISPER_BUNDLE } from '../scripts/reconcile-voice-bundles.mjs';

const canonical = JSON.parse(fs.readFileSync(new URL('../seed/profile/package.json', import.meta.url), 'utf8'));

/** One deployment home, holding the bundle selection an operator would have. */
function home(bundles, { marked = false } = {}) {
  const root = fs.mkdtempSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voice-')), 'home'));
  const web = path.join(root, 'profiles/web');
  fs.mkdirSync(web, { recursive: true });
  const manifest = {
    name: 'dsh-profile-web',
    dependencies: { 'dsh-local-speech-input': 'link:../../../dsh-local-speech' },
    dsh: { profile: { bundles } },
  };
  fs.writeFileSync(path.join(web, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (marked) fs.writeFileSync(path.join(root, '.container-voice-input-v1.json'), '{"version":1}');
  return {
    root,
    bundles: () => JSON.parse(fs.readFileSync(path.join(web, 'package.json'), 'utf8')).dsh.profile.bundles,
    manifest: () => fs.readFileSync(path.join(web, 'package.json'), 'utf8'),
  };
}

/** The selection a deployment made before the voice-input swap existed. */
const before = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  RETIRED_BUNDLE,
  'dsh-plugin-task-notification',
  'dsh-container-profile',
];

test('a pre-swap selection gains both voice bundles and loses the retired microphone', () => {
  const deployment = home(before);
  const result = reconcile(deployment.root, () => {});

  assert.equal(result.changed, true);
  const selection = deployment.bundles();
  assert.ok(!selection.includes(RETIRED_BUNDLE), 'the retired microphone must not survive the swap');
  assert.ok(selection.includes(VOICE_BUNDLE) && selection.includes(WHISPER_BUNDLE));
  // Composed with the speech service before its provider, and never last: the
  // container profile has to stay the final patch layer.
  assert.ok(selection.indexOf(VOICE_BUNDLE) < selection.indexOf(WHISPER_BUNDLE));
  assert.ok(selection.indexOf(WHISPER_BUNDLE) < selection.indexOf('dsh-container-profile'));
  assert.equal(selection.indexOf('@deepseek-ai/dsh-base'), 0);
  // Everything unrelated keeps its relative position: this is a substitution,
  // not a re-ordering of the operator's profile.
  assert.deepEqual(
    selection.filter(name => ![VOICE_BUNDLE, WHISPER_BUNDLE, RETIRED_BUNDLE].includes(name)),
    before.filter(name => name !== RETIRED_BUNDLE),
  );
  // Dependencies are operator-visible software state and stay untouched.
  assert.deepEqual(JSON.parse(deployment.manifest()).dependencies, { 'dsh-local-speech-input': 'link:../../../dsh-local-speech' });
});

test('reconciliation is remembered, so later operator choices are never fought', () => {
  const deployment = home(before);
  reconcile(deployment.root, () => {});

  // The operator re-enables the retired microphone beside the new one: that is
  // now a deliberate choice, and startup must leave it alone.
  const withBoth = [...deployment.bundles(), RETIRED_BUNDLE];
  fs.mkdirSync(path.join(deployment.root, 'profiles/web'), { recursive: true });
  fs.writeFileSync(
    path.join(deployment.root, 'profiles/web/package.json'),
    `${JSON.stringify({ dsh: { profile: { bundles: withBoth } } }, null, 2)}\n`,
  );

  const second = reconcile(deployment.root, () => {});
  assert.equal(second.changed, false);
  assert.equal(second.reason, 'reconciled previously');
  assert.deepEqual(deployment.bundles(), withBoth);
});

test('a profile that already has the replacement only loses the retired bundle', () => {
  const operator = [ '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', VOICE_BUNDLE, RETIRED_BUNDLE, 'dsh-container-profile' ];
  const deployment = home(operator);
  reconcile(deployment.root, () => {});
  const selection = deployment.bundles();
  assert.deepEqual(selection, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', VOICE_BUNDLE, 'dsh-container-profile']);
});

test('a fresh canonical profile is accepted as already reconciled', () => {
  const deployment = home(canonical.dsh.profile.bundles);
  const before = deployment.manifest();
  const result = reconcile(deployment.root, () => {});
  assert.equal(result.changed, false);
  assert.equal(deployment.manifest(), before, 'a canonical profile must not be rewritten');
  assert.ok(deployment.bundles().includes(VOICE_BUNDLE) && deployment.bundles().includes(WHISPER_BUNDLE));
});

test('an invalid or absent selection fails loudly instead of guessing', () => {
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voice-empty-'));
  assert.deepEqual(reconcile(missing, () => {}), { changed: false, reason: 'no profile manifest yet' });

  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voice-broken-'));
  fs.mkdirSync(path.join(broken, 'profiles/web'), { recursive: true });
  fs.writeFileSync(path.join(broken, 'profiles/web/package.json'), '{"dsh":{"profile":{"bundles":"nope"}}}');
  assert.throws(() => reconcile(broken, () => {}), /invalid bundle selection/);

  const symlinked = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voice-link-'));
  fs.mkdirSync(path.join(symlinked, 'profiles/web'), { recursive: true });
  const real = path.join(symlinked, 'real.json');
  fs.writeFileSync(real, '{"dsh":{"profile":{"bundles":[]}}}');
  fs.symlinkSync(real, path.join(symlinked, 'profiles/web/package.json'));
  assert.throws(() => reconcile(symlinked, () => {}), /symlinked profile manifest/);
});

test('the repository profile itself is already in the reconciled shape', () => {
  // A fresh install never runs the substitution, so the canonical list must
  // already be the end state the reconciler aims at.
  const selection = canonical.dsh.profile.bundles;
  assert.ok(!selection.includes(RETIRED_BUNDLE), 'the canonical profile must not ship the retired microphone');
  assert.ok(selection.includes(VOICE_BUNDLE) && selection.includes(WHISPER_BUNDLE));
  assert.ok(selection.indexOf(VOICE_BUNDLE) > selection.indexOf('@deepseek-ai/dsh-web-app'));
  assert.ok(selection.indexOf(VOICE_BUNDLE) < selection.indexOf(WHISPER_BUNDLE));
  assert.equal(selection.at(-1), 'dsh-container-profile', 'profile defaults must stay the last patch layer');
  // The canonical profile also has to resolve the retired bundle when an
  // operator selects it for rollback, and keep its dependency installed.
  assert.ok(canonical.dshContainer.optionalBundles.includes(RETIRED_BUNDLE));
  assert.ok('dsh-local-speech-input' in canonical.dependencies);
  assert.ok('dsh-speech-whisper' in canonical.dependencies);
});
