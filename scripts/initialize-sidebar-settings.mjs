#!/usr/bin/env node
/** Fill only absent live-console preferences before the settings service starts. */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const SIDEBAR_DEFAULTS = Object.freeze({
  agentTerminalTools: true,
  browserInterceptLinks: false,
  tabsEnabled: Object.freeze({ terminal: true, subagent: true, sidechat: false, browser: false }),
});

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Return missing leaves only; explicit false, unknown keys, and metadata survive. */
export function missingSidebarDefaults(state) {
  if (!record(state)) throw new Error('Settings must be a mapping');
  const missing = [];
  function visit(current, defaults, path) {
    if (current !== undefined && !record(current)) throw new Error('Sidebar preferences must be mappings');
    for (const [key, value] of Object.entries(defaults)) {
      const existing = current?.[key];
      if (record(value)) visit(existing, value, [...path, key]);
      else if (existing === undefined) missing.push({ path: [...path, key], value });
    }
  }
  visit(state['dsh-better-sidebar'], SIDEBAR_DEFAULTS, ['dsh-better-sidebar']);
  return missing;
}

export function initializeSidebarSettings(path, YAML) {
  const stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Settings must be a regular file');
  const original = fs.readFileSync(path, 'utf8');
  const document = YAML.parseDocument(original);
  if (document.errors.length) throw new Error('Settings YAML is invalid');
  const missing = missingSidebarDefaults(document.toJS());
  if (!missing.length) return false;
  for (const { path: keys, value } of missing) document.setIn(keys, value);
  if (fs.readFileSync(path, 'utf8') !== original) throw new Error('Settings changed during initialization');
  const temporary = `${path}.sidebar-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, String(document), { mode: stat.mode & 0o777, flag: 'wx' });
    fs.chownSync(temporary, stat.uid, stat.gid);
    fs.chmodSync(temporary, stat.mode & 0o777);
    fs.renameSync(temporary, path);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const require = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
    const changed = initializeSidebarSettings(process.argv[2] ?? '/data/dsh/settings.yaml', require('yaml'));
    console.log(changed ? 'Initialized missing live-console preferences.' : 'Live-console preferences already initialized.');
  } catch {
    console.error('Live-console settings initialization failed; existing settings were preserved.');
    process.exitCode = 23;
  }
}
