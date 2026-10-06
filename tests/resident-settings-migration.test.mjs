import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runtime = process.env.DSH_RUNTIME_ROOT ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh';
let YAML;
try { YAML = createRequire(`${runtime}/package.json`)('yaml'); } catch (error) {
  if (process.env.DSH_TEST_HARNESS === '1') throw error;
}
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

for (const selection of ['amazon-bedrock', 'local-everyday']) {
  test(`single-model file migration preserves ${selection}, private state and metadata`, { skip: !YAML }, async t => {
    const { home, file } = await fixture(t, false);
    const catalog = JSON.parse(await fs.readFile(new URL('./fixtures/resident-catalog.json', import.meta.url)));
    let body = { data: [catalog.data[0]] }, status = 200;
    const server = http.createServer((_req, res) => { res.writeHead(status); res.end(JSON.stringify(body)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const rows = YAML.parse(await fs.readFile(file, 'utf8'));
    const providers = rows.find(row => row.id === 'llm-pi-ai').config.providers;
    for (const provider of Object.values(providers)) provider.baseURL = `http://127.0.0.1:${server.address().port}/v1`;
    const external = { api: 'bedrock-converse-stream', apiKeyEnv: 'BEDROCK_PRIVATE_REFERENCE', custom: { retain: true } };
    providers['amazon-bedrock'] = external;
    const selected = { provider: selection, model: selection === 'local-everyday' ? catalog.data[1].id : 'external', reasoningEffort: 'high' };
    rows.find(row => row.id === 'agent-default-model').config = selected;
    await fs.writeFile(file, YAML.stringify(rows), { mode: 0o600 });
    const stat = await fs.stat(file);
    const session = `${home}/session.jsonl`;
    await fs.writeFile(session, 'unchanged session history');
    const launch = () => exec(process.execPath, [script, '--startup', `${home}/settings.yaml`], {
      env: { ...process.env, DSH_RUNTIME_ROOT: runtime },
    });
    await launch();
    const migrated = YAML.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(migrated.find(row => row.id === 'agent-default-model').config, selected);
    const next = migrated.find(row => row.id === 'llm-pi-ai').config.providers;
    assert.deepEqual(next['amazon-bedrock'], external);
    assert.equal(next['local-everyday'].residentUnavailable, true);
    const after = await fs.stat(file);
    assert.equal(after.mode, stat.mode); assert.equal(after.uid, stat.uid); assert.equal(after.gid, stat.gid);
    assert.equal(await fs.readFile(session, 'utf8'), 'unchanged session history');
    const bytes = await fs.readFile(file, 'utf8');
    await launch();
    assert.equal(await fs.readFile(file, 'utf8'), bytes);
    // HTTP and metadata failures are not transport-outage fallback.
    status = 503;
    await assert.rejects(launch(), e => e.code === 22);
    assert.equal(await fs.readFile(file, 'utf8'), bytes);
    status = 200; body = catalog; body.data[1].x_ollama_router.complete = false;
    await assert.rejects(launch(), e => e.code === 22);
    assert.equal(await fs.readFile(file, 'utf8'), bytes);
    await new Promise(resolve => server.close(resolve));
    server.close = callback => callback();
    assert.match((await launch()).stdout, /temporarily unavailable/);
    assert.equal(await fs.readFile(file, 'utf8'), bytes);
  });
}
