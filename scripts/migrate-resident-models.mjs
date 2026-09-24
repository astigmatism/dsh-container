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
const { synchronizeRouterSettings, applyOperation, RESIDENT_MODELS } = await loadRouterContract();
const configured = state['llm-pi-ai']?.providers;
const selected = state['agent-default-model'];
const current = configured && Object.keys(configured).length === 2 &&
  Object.entries(RESIDENT_MODELS).every(([name, model]) => {
    const provider = configured[name];
    return provider?.api === 'openai-responses' && provider.models?.length === 1 &&
      provider.models[0].id === model && provider.models[0].maxTokens === null &&
      provider.maxConcurrency === 1 && typeof provider.baseURL === 'string';
  }) && selected && RESIDENT_MODELS[selected.provider] === selected.model &&
  (selected.reasoningEffort === undefined || configured[selected.provider].models[0].reasoningEfforts?.[selected.reasoningEffort]);
try {
await synchronizeRouterSettings({
  get: namespace => state[namespace],
  describe: () => [{ ns: 'llm-pi-ai', user: state['llm-pi-ai'] }],
  mutate: async (namespace, operations) => {
    for (const operation of operations) applyOperation(state[namespace], operation);
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
    if (profile) {
      for (const id of ['llm-pi-ai', 'agent-default-model']) {
        const row = document.contents.items.find(row => row.get('id') === id);
        if (row) row.set('config', state[id]);
        else document.contents.add(document.createNode({ id, config: state[id] }));
      }
    }
    fs.writeFileSync(temporary, profile ? String(document) : YAML.stringify(state), { mode: stat.mode & 0o777, flag: 'wx' });
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
