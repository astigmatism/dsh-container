#!/usr/bin/env node
/** Move pre-0.1.7 preferences into the user-owned profile, once and atomically. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
const digest = value => createHash('sha256').update(value).digest('hex');
import { isDeepStrictEqual } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const sectionIds = {
  'dsh-better-sidebar': 'better-sidebar',
  'ui-developer-tools': 'ui-settings',
  'ui-onboarding': 'ui-settings-general',
  shell: 'bash-sandbox',
};
const sidebarKeys = new Set(['readLimit', 'mediaLimit', 'uploadLimit', 'listLimit',
  'autoOpenSubagent', 'autoOpenJobs', 'agentOpenTools', 'editorExplorer',
  'workspaceFence', 'titleBarScheme', 'titleBarPresetId', 'customCss', 'titleBarCompat',
  'titleBarStripPx', 'htmlViewerNoSandbox', 'htmlViewerDefaultUnsafe', 'tabsEnabled',
  'viewersEnabled', 'pluginSettings']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const yamlOptions = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] };

function readDocument(file, YAML) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Migration inputs must be regular files');
  const source = fs.readFileSync(file, 'utf8');
  const doc = YAML.parseDocument(source, yamlOptions);
  if (doc.errors.length) throw new Error('Invalid migration input YAML');
  return { source, doc, stat };
}

/** Keep differences from the previous managed layer, including tagged expressions. */
export function userOverrides(document, baseline, YAML) {
  if (!YAML.isSeq(document.contents) || !YAML.isSeq(baseline.contents)) throw new Error('Profile patches must be arrays');
  const known = new Map();
  for (const row of baseline.contents.items) {
    if (row.has('id')) known.set(row.get('id'), row);
    for (const child of row.get('insert')?.items ?? []) known.set(child.get('id'), child);
  }
  const output = new YAML.Document([]);
  function changed(node, base) {
    const copy = node.clone();
    for (const pair of [...copy.items]) {
      const key = pair.key.value;
      if (key === 'id') continue;
      const old = base.get(key, true);
      if (old === undefined) continue;
      if (isDeepStrictEqual(pair.value?.toJSON(), old.toJSON())) copy.delete(key);
      else if (YAML.isMap(pair.value) && YAML.isMap(old)) copy.set(key, changed(pair.value, old));
    }
    return copy;
  }
  function keep(row, inserted = false) {
    const old = known.get(row.get('id'));
    if (!old) {
      if (inserted) output.contents.add(output.createNode({ insert: [row.clone()] }));
      else output.contents.add(row.clone());
      return;
    }
    const delta = changed(row, old);
    if (delta.items.some(pair => pair.key.value !== 'id')) output.contents.add(delta);
  }
  for (const row of document.contents.items) {
    if (!YAML.isMap(row)) throw new Error('Profile patch rows must be mappings');
    if (row.has('insert')) {
      // Canonical insertions now come from the managed bundle. User additions remain.
      for (const child of row.get('insert').items) keep(child, true);
    } else keep(row);
  }
  return output;
}

export function migrateProfile(home, defaultsRoot, YAML) {
  const marker = path.join(home, '.container-settings-v1.json');
  const patch = path.join(home, 'profiles/web/cordis.patch.yml');
  if (fs.existsSync(marker)) {
    if (!YAML.isSeq(readDocument(patch, YAML).doc.contents)) throw new Error('Profile patches must be arrays');
    return false;
  }
  const legacy = path.join(home, 'settings.yaml');
  const imported = `${legacy}.imported`;
  const pending = path.join(home, '.container-settings-pending.json');
  // Resume after an interruption between publishing the patch and archiving legacy input.
  if (fs.existsSync(pending)) {
    const receipt = JSON.parse(fs.readFileSync(pending, 'utf8'));
    const current = readDocument(patch, YAML);
    if (digest(current.source) === receipt.originalSHA256 && fs.existsSync(receipt.temporary)) {
      if (path.dirname(receipt.temporary) !== home ||
          !path.basename(receipt.temporary).startsWith('.container-settings-prepared-')) {
        throw new Error('Pending migration has an invalid prepared profile');
      }
      const prepared = readDocument(receipt.temporary, YAML);
      if (digest(prepared.source) !== receipt.patchSHA256) {
        throw new Error('Pending migration has an invalid prepared profile');
      }
      fs.renameSync(receipt.temporary, patch);
      return migrateProfile(home, defaultsRoot, YAML);
    }
    if (digest(current.source) !== receipt.patchSHA256) throw new Error('Pending migration profile changed; refusing to finalize');
    if (fs.existsSync(legacy)) {
      if (fs.existsSync(imported)) throw new Error('Both legacy settings and its archive exist during recovery');
      if (digest(readDocument(legacy, YAML).source) !== receipt.legacySHA256) {
        throw new Error('Legacy settings changed during migration; refusing to archive them');
      }
      fs.renameSync(legacy, imported);
    }
    if (!fs.existsSync(imported)) throw new Error('Pending migration has no legacy settings archive');
    fs.renameSync(pending, marker);
    return false;
  }
  if (fs.existsSync(imported)) throw new Error('Legacy settings archive already exists; inspect the saved migration before proceeding');
  const input = readDocument(legacy, YAML);
  const state = input.doc.toJS();
  if (!object(state)) throw new Error('Legacy settings must be a mapping');
  const profile = readDocument(patch, YAML);
  const baseline = readDocument(path.join(defaultsRoot, 'legacy-profile-alpha1.yaml'), YAML);
  const output = userOverrides(profile.doc, baseline.doc, YAML);
  const migrated = [];
  for (const [section, stored] of Object.entries(state)) {
    if (!object(stored)) throw new Error(`Settings section ${section} must be a mapping`);
    const id = sectionIds[section] ?? section;
    let config = structuredClone(stored);
    if (section === 'dsh-better-sidebar') {
      config = Object.fromEntries(Object.entries(config).filter(([key]) => sidebarKeys.has(key)));
      // Removed terminal/browser kinds belong to the native host now.
      if (config.tabsEnabled) {
        delete config.tabsEnabled.terminal;
        delete config.tabsEnabled.browser;
      }
    }
    if (Object.keys(config).length) {
      const existing = output.contents.items.find(row => row.get('id') === id);
      if (existing) {
        const prior = existing.get('config', true);
        if (prior && !YAML.isMap(prior)) throw new Error(`Cannot merge profile preferences for ${id}`);
        const merged = output.createNode(config);
        function overlay(target, overrides) {
          for (const pair of overrides?.items ?? []) {
            const key = pair.key.value;
            const base = target.get(key, true);
            if (YAML.isMap(base) && YAML.isMap(pair.value)) overlay(base, pair.value);
            else target.set(key, pair.value.clone());
          }
        }
        overlay(merged, prior);
        existing.set('config', merged);
      } else output.contents.add(output.createNode({ id, config }));
      migrated.push(id);
    }
  }
  const backup = path.join(home, 'profile-before-0.1.7.yaml');
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, profile.source, { flag: 'wx', mode: 0o600 });
  if (fs.readFileSync(legacy, 'utf8') !== input.source || fs.readFileSync(patch, 'utf8') !== profile.source) {
    throw new Error('Configuration changed during migration');
  }
  // Keep the prepared document outside the software-managed profile tree so
  // startup synchronization cannot remove it before interrupted-write recovery.
  const temporary = path.join(home, `.container-settings-prepared-${randomUUID()}.yaml`);
  const receipt = JSON.stringify({ version: 1, release: '0.1.7-rc.2', entries: migrated,
    temporary, originalSHA256: digest(profile.source), legacySHA256: digest(input.source),
    patchSHA256: digest(String(output)) }) + '\n';
  try {
    fs.writeFileSync(temporary, String(output), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(pending, receipt, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, patch);
    fs.renameSync(legacy, imported);
    fs.renameSync(pending, marker);
  } finally {
    // The receipt owns the prepared file until recovery finishes publication.
    if (!fs.existsSync(pending)) fs.rmSync(temporary, { force: true });
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const require = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
  const changed = migrateProfile(process.argv[2] ?? '/data/dsh', '/opt/dsh-defaults', require('yaml'));
  console.log(changed ? 'Migrated legacy preferences to the persistent web profile.' : 'Persistent web profile already initialized.');
}
