import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runtime = process.env.DSH_RUNTIME_ROOT ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh';
let YAML;
try { YAML = createRequire(`${runtime}/package.json`)('yaml'); } catch {}
const exec = promisify(execFile);
const script = new URL('../scripts/migrate-resident-models.mjs', import.meta.url).pathname;

async function fixture(t, retired) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'resident-migration-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const settings = YAML.parse(await fs.readFile(new URL('../config/settings.yaml', import.meta.url), 'utf8'));
  for (const provider of Object.values(settings['llm-pi-ai'].providers)) provider.baseURL = 'http://127.0.0.1:1/v1';
  if (retired) settings['agent-default-model'].provider = 'local-ollama-256k';
  const file = path.join(home, 'profiles/web/cordis.patch.yml');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const source = YAML.stringify(Object.entries(settings).map(([id, config]) => ({ id, config })));
  await fs.writeFile(file, source, { mode: 0o600 });
  return { home, file, source };
}

test('startup defers a router outage only for already valid resident settings', { skip: !YAML }, async t => {
  const { home, file, source } = await fixture(t, false);
  const result = await exec(process.execPath, [script, '--startup', `${home}/settings.yaml`], {
    env: { ...process.env, DSH_RUNTIME_ROOT: runtime },
  });
  assert.match(result.stdout, /validated resident settings were preserved/);
  assert.equal(await fs.readFile(file, 'utf8'), source);
});

test('failed active-model migration stops startup without changing the saved profile', { skip: !YAML }, async t => {
  const { home, file, source } = await fixture(t, true);
  await assert.rejects(exec(process.execPath, [script, '--startup', `${home}/settings.yaml`], {
    env: { ...process.env, DSH_RUNTIME_ROOT: runtime },
  }), error => error.code === 22 && error.stderr.includes('Router settings migration failed'));
  assert.equal(await fs.readFile(file, 'utf8'), source);
});
