#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { migrateProfile } from './migrate-profile-settings.mjs';

const scheduleBundle = '@deepseek-ai/dsh-experimental-schedule-bundle';
const options = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] };
const hash = value => createHash('sha256').update(value).digest('hex');
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Profile migration requires regular files');
  return fs.readFileSync(file, 'utf8');
}
function atomic(file, source) {
  const temporary = file + '.02-prepared-' + process.pid;
  fs.writeFileSync(temporary, source, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}
export function migrate(home, YAML, defaultsRoot = process.env.DSH_DEFAULTS_ROOT || '/opt/dsh-defaults') {
  const marker = path.join(home, '.container-profile-02.json');
  const pending = marker + '.pending';
  const manifest = path.join(home, 'profiles/web/package.json');
  const patch = path.join(home, 'profiles/web/cordis.patch.yml');
  for (const directory of [home, path.join(home, 'profiles'), path.join(home, 'profiles/web'), path.join(home, 'profile-before-02')]) {
    if (fs.existsSync(directory) && (fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory())) throw new Error('Profile migration refuses symlinked or invalid directories');
  }
  if (fs.existsSync(marker) || !fs.existsSync(manifest) || !fs.existsSync(patch)) return false;
  let transaction;
  if (fs.existsSync(pending)) transaction = JSON.parse(regular(pending));
  else {
    const packageSource = regular(manifest);
    const pkg = JSON.parse(packageSource);
    // New installations already use the 0.2 bundle composition and defaults.
    if (pkg.dshContainer) { atomic(marker, JSON.stringify({ version: 1, fresh: true })); return false; }
    // Older deployments still have a namespace-based settings.yaml. Import it
    // before retiring browser/Token targets so later startup cannot reintroduce
    // settings for plugins absent from the new composition.
    if (!fs.existsSync(path.join(home, '.container-settings-v1.json')) &&
        (fs.existsSync(path.join(home, 'settings.yaml')) || fs.existsSync(path.join(home, '.container-settings-pending.json')))) {
      migrateProfile(home, defaultsRoot, YAML);
    }
    const patchSource = regular(patch);
    const doc = YAML.parseDocument(patchSource, options);
    if (doc.errors.length || !YAML.isSeq(doc.contents)) throw new Error('Invalid saved profile patch');
    const rows = doc.contents.items;
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].get?.('id') === 'dsh-token') rows.splice(i, 1);
    const schedule = rows.find(row => row.get?.('id') === 'schedule');
    const scheduleEnabled = schedule?.get('disabled') === false;
    const conditionalSchedule = schedule?.get('disabled', true)?.tag === 'tag:yaml.org,2002:js';
    if ((scheduleEnabled || conditionalSchedule) && !pkg.dsh.profile.bundles.includes(scheduleBundle)) pkg.dsh.profile.bundles.push(scheduleBundle);
    if (!pkg.dsh.profile.bundles.includes(scheduleBundle)) {
      // These targets were removed from the core. Preserve them in the archive,
      // but don't leave dangling patch targets that make the new loader fail.
      for (let i = rows.length - 1; i >= 0; i--) if (['schedule', 'ui-schedule', 'time-context'].includes(rows[i].get?.('id'))) rows.splice(i, 1);
    }

    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].get?.('id') === 'dsh-playwright') {
        // Preserve explicit enablement; obsolete browser configuration remains in the backup.
        if (rows[i].has('disabled')) rows[i] = doc.createNode({ id: 'ego-browser', disabled: rows[i].get('disabled', true).clone?.() ?? rows[i].get('disabled') });
        else rows.splice(i, 1);
      }
    }
    let chat = rows.find(row => row.get?.('id') === 'ui-chat');
    if (!chat) { chat = doc.createNode({ id: 'ui-chat', config: { transcriptView: 'standard' } }); rows.push(chat); }
    else {
      const view = chat.getIn(['config', 'transcriptView']);
      if (view === undefined || view === null || view === 'normal') chat.setIn(['config', 'transcriptView'], 'standard');
    }
    // Content-addressed backup survives interrupted publication and is never overwritten.
    const backup = path.join(home, 'profile-before-02');
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    for (const [name, source] of [['package.json', packageSource], ['cordis.patch.yml', patchSource]]) {
      const file = path.join(backup, hash(source) + '-' + name);
      if (!fs.existsSync(file)) fs.writeFileSync(file, source, { flag: 'wx', mode: 0o600 });
    }
    transaction = { version: 1, files: [
      { file: 'package.json', before: hash(packageSource), source: JSON.stringify(pkg, null, 2) + '\n' },
      { file: 'cordis.patch.yml', before: hash(patchSource), source: String(doc) },
    ] };
    atomic(pending, JSON.stringify(transaction));
  }
  for (const entry of transaction.files) {
    if (!['package.json', 'cordis.patch.yml'].includes(entry.file)) throw new Error('Invalid profile migration journal');
    const file = path.join(home, 'profiles/web', entry.file), current = regular(file);
    if (current === entry.source) continue;
    if (hash(current) !== entry.before) throw new Error('Profile changed during migration; restore or inspect the journal');
    atomic(file, entry.source);
  }
  fs.renameSync(pending, marker);
  return true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = process.env.DSH_RUNTIME_ROOT || '/usr/local/lib/node_modules/@deepseek-ai/dsh';
  const YAML = createRequire(`${runtime}/package.json`)('yaml');
  if (migrate(process.argv[2], YAML)) console.log('Migrated profile activation and presentation preferences for Harness 0.2.');
}
