#!/usr/bin/env node
/**
 * One-time voice-input bundle reconciliation.
 *
 * The repository selects the official Voice Input bundle plus this image's
 * Whisper provider. Activation is deliberately operator state, and
 * `scripts/sync-runtime-profile.sh` preserves the bundle selection in
 * `profiles/web/package.json` across every update, so a deployment created
 * before the swap would keep mounting the retired DOM-patched microphone next
 * to the new control forever. Substitute it once per DSH_HOME.
 *
 * After the marker exists the operator owns the selection: disabling either
 * voice bundle, or deliberately re-enabling the retired microphone, stays
 * exactly as chosen and is never fought at startup. The retired bundle is only
 * ever removed in a pass where its replacement is actually selected, so the
 * composer never loses its microphone to a half-applied reconciliation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEB_BUNDLE = '@deepseek-ai/dsh-web-app';
export const VOICE_BUNDLE = '@deepseek-ai/dsh-experimental-voice-input-bundle';
export const WHISPER_BUNDLE = 'dsh-speech-whisper';
export const RETIRED_BUNDLE = 'dsh-local-speech-input';
export const MARKER = '.container-voice-input-v1.json';

/**
 * Apply the substitution to one DSH_HOME.
 * @param home - DSH_HOME whose `profiles/web/package.json` is reconciled.
 * @param log - one-line reporter; defaults to stdout.
 * @returns `{ changed, selection }`, or `{ changed: false, reason }` when the
 *   substitution has already been made for this home.
 */
export function reconcile(home, log = line => console.log(line)) {
  const manifest = path.join(home, 'profiles/web/package.json');
  if (fs.existsSync(manifest) && fs.lstatSync(manifest).isSymbolicLink()) {
    throw new Error('Voice bundle reconciliation refuses a symlinked profile manifest');
  }
  if (!fs.existsSync(manifest)) return { changed: false, reason: 'no profile manifest yet' };
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const bundles = pkg?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || !bundles.every(name => typeof name === 'string')) {
    throw new Error('Voice bundle reconciliation found an invalid bundle selection');
  }
  if (fs.existsSync(path.join(home, MARKER))) {
    return { changed: false, reason: 'reconciled previously', selection: bundles };
  }

  let selection = bundles.slice();
  if (!selection.includes(VOICE_BUNDLE)) {
    // Insert the pair right after the web bundle, where the canonical profile
    // keeps them, so the speech service is composed before its provider.
    selection.splice(selection.indexOf(WEB_BUNDLE) + 1, 0, VOICE_BUNDLE, WHISPER_BUNDLE);
  }
  if (selection.includes(VOICE_BUNDLE)) selection = selection.filter(name => name !== RETIRED_BUNDLE);

  const added = selection.filter(name => !bundles.includes(name));
  const removed = bundles.filter(name => !selection.includes(name));
  if (added.length > 0 || removed.length > 0) {
    // Byte format matches the profile sync, so a reconciliation does not make
    // the next sync see a spurious rewrite of the whole manifest.
    const temporary = `${manifest}.voice-reconciled-${process.pid}`;
    const body = `${JSON.stringify({ ...pkg, dsh: { ...pkg.dsh, profile: { ...pkg.dsh.profile, bundles: selection } } }, null, 2)}\n`;
    fs.writeFileSync(temporary, body, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, manifest);
  }
  fs.writeFileSync(path.join(home, MARKER), JSON.stringify({ version: 1, added, removed }), { mode: 0o600 });
  log(`Voice input bundles: added ${added.join(', ') || 'nothing'}, retired ${removed.join(', ') || 'nothing'}`);
  return { changed: added.length + removed.length > 0, selection };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  reconcile(process.argv[2] ?? process.env.DSH_HOME ?? '/data/dsh');
}
