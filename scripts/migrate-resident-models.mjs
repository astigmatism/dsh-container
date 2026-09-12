#!/usr/bin/env node
/** Atomic pre-launch migration; the plugin maintains later capability refresh. */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { loadRouterContract } from './verify-router-contract.mjs';
const require = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
const YAML = require('yaml');
async function main() {
const startup = process.argv[2] === '--startup';
const path = process.argv[startup ? 3 : 2] ?? '/data/dsh/settings.yaml';
const stat = fs.lstatSync(path);
if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Router settings must be a regular file');
const original = fs.readFileSync(path, 'utf8');
const state = YAML.parse(original);
const { synchronizeRouterSettings, applyOperation } = await loadRouterContract();
await synchronizeRouterSettings({
  get: namespace => state[namespace],
  describe: () => [{ ns: 'llm-pi-ai', user: state['llm-pi-ai'] }],
  mutate: async (namespace, operations) => {
    for (const operation of operations) applyOperation(state[namespace], operation);
  }
});
if (JSON.stringify(state) === JSON.stringify(YAML.parse(original))) {
  console.log('Resident model configuration is already current.');
} else {
  if (fs.readFileSync(path, 'utf8') !== original) throw new Error('Router settings changed during discovery; refusing to overwrite them');
  if (!startup) fs.writeFileSync(path + '.before-residents-' + Date.now(), original, { mode: 0o600, flag: 'wx' });
  const temporary = path + '.resident-' + randomUUID();
  try {
    fs.writeFileSync(temporary, YAML.stringify(state), { mode: stat.mode & 0o777, flag: 'wx' });
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
