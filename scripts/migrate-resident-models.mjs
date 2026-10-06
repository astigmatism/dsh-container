#!/usr/bin/env node
/** Atomic pre-launch migration; the plugin maintains later capability refresh. */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { loadRouterContract } from './verify-router-contract.mjs';
const require = createRequire(`${process.env.DSH_RUNTIME_ROOT ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh'}/package.json`);
const YAML = require('yaml');
async function main() {
const startup = process.argv[2] === '--startup';
let path = process.argv[startup ? 3 : 2] ?? '/data/dsh/settings.yaml';
if (!fs.existsSync(path) && path.endsWith('/settings.yaml')) {
  path = path.slice(0, -'settings.yaml'.length) + 'profiles/web/cordis.patch.yml';
}
const stat = fs.lstatSync(path);
if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Router settings must be a regular file');
const original = fs.readFileSync(path, 'utf8');
const document = YAML.parseDocument(original, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
if (document.errors.length) throw new Error('Invalid settings YAML');
const parsed = document.toJS();
const profile = Array.isArray(parsed);
const state = profile ? Object.fromEntries(parsed.filter(row => row.id && row.config).map(row => [row.id, row.config])) : parsed;
const initialState = JSON.stringify(state);
const changes = [];
const { synchronizeRouterSettings, applyOperation, currentResidentSettings } = await loadRouterContract();
const current = currentResidentSettings(state['llm-pi-ai'], state['agent-default-model']);
try {
await synchronizeRouterSettings({
  get: namespace => state[namespace],
  describe: () => [{ ns: 'llm-pi-ai', user: state['llm-pi-ai'] }],
  mutate: async (namespace, operations) => {
    for (const operation of operations) {
      const previous = operation.path.reduce((value, key) => value?.[key], state[namespace]);
      changes.push({ namespace, operation, previous: structuredClone(previous) });
      applyOperation(state[namespace], operation);
    }
  }
});
} catch (error) {
  const unavailable = error.name === 'TimeoutError' || error.name === 'AbortError' ||
    (error instanceof TypeError && error.message === 'fetch failed');
  if (!startup || !current || !unavailable) throw error;
  console.log('Router discovery is temporarily unavailable; validated resident settings were preserved.');
  return;
}
if (JSON.stringify(state) === initialState) {
  console.log('Resident model configuration is already current.');
} else {
  if (fs.readFileSync(path, 'utf8') !== original) throw new Error('Router settings changed during discovery; refusing to overwrite them');
  if (!startup) fs.writeFileSync(path + '.before-residents-' + Date.now(), original, { mode: 0o600, flag: 'wx' });
  const temporary = path + '.resident-' + randomUUID();
  try {
    // Patch only changed leaves in the YAML document. Re-serializing the
    // namespace would turn unrelated !js expressions into plain strings.
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const patch = (keys, previous, value) => {
      if (JSON.stringify(previous) === JSON.stringify(value)) return;
      if (object(previous) && object(value) && YAML.isMap(document.getIn(keys, true))) {
        for (const key of Object.keys(previous)) if (!Object.hasOwn(value, key)) document.deleteIn([...keys, key]);
        for (const [key, child] of Object.entries(value)) patch([...keys, key], previous[key], child);
      } else if (Array.isArray(previous) && Array.isArray(value) && previous.length === value.length) {
        value.forEach((child, index) => patch([...keys, index], previous[index], child));
      } else document.setIn(keys, value);
    };
    for (const { namespace, operation, previous } of changes) {
      let prefix = [namespace];
      if (profile) {
        let index = document.contents.items.findIndex(row => row.get('id') === namespace);
        if (index < 0) {
          document.contents.add(document.createNode({ id: namespace, config: {} }));
          index = document.contents.items.length - 1;
        }
        prefix = [index, 'config'];
      }
      const keys = [...prefix, ...operation.path];
      if (operation.op === 'unset') document.deleteIn(keys);
      else patch(keys, previous, operation.value);
    }
    fs.writeFileSync(temporary, String(document), { mode: stat.mode & 0o777, flag: 'wx' });
    fs.chownSync(temporary, stat.uid, stat.gid);
    fs.chmodSync(temporary, stat.mode & 0o777);
    fs.renameSync(temporary, path);
  } finally { fs.rmSync(temporary, { force: true }); }
  console.log('Migrated advertised router capabilities; explicit choices and settings metadata preserved.');
}

}
try { await main(); } catch (error) {
  console.error(`Router settings migration failed: ${error.message}`);
  process.exitCode = 22;
}
