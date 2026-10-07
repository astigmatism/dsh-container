#!/usr/bin/env node
/** Atomic pre-launch migration; the plugin maintains later capability refresh.
 *
 * Router state never stops startup (docs/llm-router-contract.md §4): an
 * unreachable router or an offline, unhealthy or incomplete model is recorded
 * per model and the plugin recovers automatically after launch. Only invalid
 * local settings exit non-zero.
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { loadRouterContract } from './verify-router-contract.mjs';
const require = createRequire(`${process.env.DSH_RUNTIME_ROOT ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh'}/package.json`);
const YAML = require('yaml');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Old persisted IDs of Harness-owned routes, anywhere outside the provider map. */
export function routeMigrations(state, services) {
  const operations = [];
  const visit = (namespace, value, path) => {
    if (Array.isArray(value)) { value.forEach((child, index) => visit(namespace, child, [...path, index])); return; }
    if (!object(value)) return;
    for (const [providerKey, modelKey] of [['provider', 'model'], ['summarizationProvider', 'summarizationModel']]) {
      const service = services[value[providerKey]];
      if (typeof service === 'string' && typeof value[modelKey] === 'string' && value[modelKey].length && value[modelKey] !== service) {
        operations.push({ namespace, operation: { op: 'set', path: [...path, modelKey], value: service } });
      }
    }
    for (const [key, child] of Object.entries(value)) visit(namespace, child, [...path, key]);
  };
  for (const [namespace, config] of Object.entries(state)) if (namespace !== 'llm-pi-ai') visit(namespace, config, []);
  return operations;
}

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
  if (!profile && !object(parsed)) throw new Error('Settings must be a mapping or a profile patch');
  const state = profile ? Object.fromEntries(parsed.filter(row => row?.id && object(row.config)).map(row => [row.id, row.config])) : parsed;
  const initialState = JSON.stringify(state);
  const changes = [];
  const record = (namespace, operation) => {
    const previous = operation.path.reduce((value, key) => value?.[key], state[namespace]);
    changes.push({ namespace, operation, previous: structuredClone(previous) });
    state[namespace] ??= {};
    applyOperation(state[namespace], operation);
  };
  const { synchronizeRouterSettings, applyOperation, RESIDENT_SERVICES, routerClientName, describeStatus } = await loadRouterContract();
  const discovery = state['router-model-discovery'];
  const outcome = await synchronizeRouterSettings({
    get: namespace => state[namespace],
    describe: () => [{ ns: 'llm-pi-ai', user: state['llm-pi-ai'] }],
    mutate: async (namespace, operations) => { for (const operation of operations) record(namespace, operation); },
  }, {
    clientName: routerClientName({ instance: object(discovery) ? discovery.clientInstance : undefined }),
    fetchOptions: { timeoutMs: 10_000 },
    onFetchError: (_base, error) => console.log(`Router discovery is unavailable at startup (${error.name === 'TimeoutError' ? 'timeout' : error.message}); starting with stored settings and both models marked unavailable. Discovery recovers automatically.`),
  });
  if (outcome.errors.length) throw new Error(outcome.errors.map(({ provider, error }) => `${provider}: ${error.message}`).join('; '));
  for (const [provider, { state: resident }] of outcome.results) {
    console.log(`${RESIDENT_SERVICES[provider]}: ${describeStatus(resident)}`);
  }
  for (const { namespace, operation } of routeMigrations(state, RESIDENT_SERVICES)) record(namespace, operation);
  if (JSON.stringify(state) === initialState) {
    console.log('Resident model configuration is already current.');
    return;
  }
  if (fs.readFileSync(path, 'utf8') !== original) throw new Error('Router settings changed during discovery; refusing to overwrite them');
  if (!startup) fs.writeFileSync(path + '.before-residents-' + Date.now(), original, { mode: 0o600, flag: 'wx' });
  const temporary = path + '.resident-' + randomUUID();
  try {
    // Patch only changed leaves in the YAML document. Re-serializing the
    // namespace would turn unrelated !js expressions into plain strings.
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
        let index = document.contents.items.findIndex(row => YAML.isMap(row) && row.get('id') === namespace);
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
  console.log('Migrated resident routes to router service IDs and recorded each model state; explicit choices and settings metadata preserved.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch (error) {
    // Only local settings can fail here; router state is recorded, not fatal.
    console.error(`Router settings migration failed: ${error.message}`);
    process.exitCode = 22;
  }
}
