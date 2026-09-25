/** Deployment gate for the real model catalog, picker, effort control and inference. */
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readSettings, residentClientExpectations } from './verify-router-contract.mjs';
import { launchVerificationBrowser } from './verification-browser.mjs';
import { waitForVerificationTurn, openVerificationSession } from './verification-state.mjs';

const base = process.env.DSH_VERIFY_URL ?? 'http://127.0.0.1:3080';
const profile = process.env.DSH_PROFILE_ROOT ?? '/data/dsh/profiles/web';
const require = createRequire(`${profile}/package.json`);
const { chromium } = require('playwright-core');
const secret = process.env.DSH_BOOT_TOKEN ?? (await readFile('/run/dsh-backend-auth/launch-token', 'utf8')).trim();
const live = process.argv.includes('--live');
const settingsPath = process.env.DSH_VERIFY_SETTINGS ?? resolve(profile, '../../settings.yaml');
const { browser, close } = await launchVerificationBrowser(chromium);
const context = await browser.newContext();
const page = await context.newPage();
let sessionId;
let originalDefault;
let fixture;
let workspaceId;
const browserErrors = [];
page.on('pageerror', error => browserErrors.push(error.message));
page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });
async function rpc(name, request = {}) {
  const method = name.includes('/') ? name : `session/${name}`;
  const response = await context.request.post(`${base}/api/${method}`, { data: {
    type: 'client-request', rpcId: randomUUID(), method,
    payload: { args: name === 'modelCatalog' ? {} : name === 'list' ? { _request: request } : { request } },
  } });
  assert.equal(response.status(), 200, `${name}: HTTP status`);
  const { result } = await response.json();
  assert.equal(result.ok, true, `${name}: ${result.error?.message}`);
  return result.value;
}
try {
  const expected = await residentClientExpectations(await readSettings(settingsPath), { live });
  await context.request.get(`${base}/?token=${encodeURIComponent(secret)}`);
  const catalog = await rpc('modelCatalog');
  originalDefault = catalog.default;
  assert.deepEqual(catalog.failures, []);
  assert.deepEqual(catalog.routableProviders.sort(), expected.map(row => row.provider).sort());
  assert.deepEqual(catalog.groups.flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id, name: model.name }))),
    expected.map(({ provider, model, name }) => ({ provider, model, name })));
  for (const group of catalog.groups) {
    assert.equal(group.models[0].reasoning.defaultEffort, expected.find(row => row.provider === group.id).reasoningEffort);
    assert.ok(group.models[0].reasoning.efforts.some(effort => effort.id === 'xhigh'));
  }
  fixture = await mkdtemp('/tmp/dsh-resident-verification-');
  const created = await rpc('workspace/create', { path: fixture });
  workspaceId = created.workspace.workspaceId;
  ({ sessionId } = await rpc('create', { workspaceId }));
  // The sidebar omits empty drafts. Materialize this isolated conversation
  // before opening its session-specific model controls. Offline image tests
  // intentionally have no inference endpoint; only live mode requires replies.
  await rpc('prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text:
    'Text-only verification. Do not use tools or access files. Reply with READY.' }] });
  if (!live) await rpc('cancel', { sessionId });
  await waitForVerificationTurn(rpc, sessionId, { phase: 'initial READY prompt', marker: 'READY',
    allowCancellation: !live, timeoutMs: live ? 600000 : 90000 });
  const title = `Resident model verification ${sessionId.slice(-8)}`;
  await rpc('rename', { sessionId, title });
  await page.goto(base, { waitUntil: 'networkidle' });
  await openVerificationSession(page, { workspaceId, workspaceTitle: created.workspace.title, sessionId });
  await page.waitForSelector('[data-composer-input]');
  const trigger = page.getByRole('button', { name: /^Select model/ });
  await trigger.click();
  await page.getByRole('menuitem', { name: /^Model/ }).click();
  assert.deepEqual(await page.getByRole('menuitemradio').allTextContents(), expected.map(row => row.name));
  await trigger.click();
  await trigger.click();
  await page.getByRole('menuitem', { name: /^Effort/ }).click();
  assert.deepEqual(await page.getByRole('menuitemradio').allTextContents(), ['Off', 'Minimal', 'Low', 'Medium', 'High', 'Xhigh', 'Max']);
  await trigger.click();
  console.log(`Live Harness catalog and rendered picker contain exactly ${expected.map(row => row.name).join(' and ')}, with a separate effort control.`);
  if (live) {
    for (const [index, choice] of expected.entries()) {
      await rpc('selectModel', { sessionId, provider: choice.provider, model: choice.model, reasoningEffort: 'medium' });
      const marker = `RESIDENT_${index}_${randomUUID().slice(0, 8)}`;
      const before = (await rpc('list')).items.find(item => item.sessionId === sessionId);
      assert.ok(before, 'verification session exists before inference');
      await rpc('prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text:
        `Text-only model acceptance check. Do not use tools or access files. Reply with exactly ${marker} and no other text.` }] });
      await waitForVerificationTurn(rpc, sessionId, { phase: `${choice.name} inference`, marker,
        afterSeq: before.projections?.asOfSeq ?? -1 });
      const meter = page.getByRole('button', { name: /% of context used/ });
      await meter.click();
      const capacity = `${Math.round(choice.contextWindow / 1000)}K`; // Upstream meter uses decimal K.
      await page.getByRole('dialog').filter({ hasText: new RegExp(`/ ${capacity}`) }).waitFor();
      await page.keyboard.press('Escape');
      console.log(`${choice.name}: live application inference and durable session continuation passed.`);
    }
  }
} catch (error) {
  console.error(String(error?.stack ?? error).split(secret).join('<redacted>'));
  const directory = process.env.DSH_VERIFY_DIAGNOSTICS;
  if (directory) {
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const tree = await page.getByRole('tree').allTextContents();
      await writeFile(resolve(directory, 'resident.json'), JSON.stringify({ code: error.code,
        error: String(error), browserErrors, workspaceId, sessionId, tree }, null, 2)
        .split(secret).join('<redacted>'), { mode: 0o600 });
      await page.screenshot({ path: resolve(directory, 'resident.png') });
    } catch { console.error('Could not save all isolated browser diagnostics.'); }
  }
  process.exitCode = 1;
} finally {
  if (sessionId) {
    await rpc('cancel', { sessionId }).catch(() => {});
    if (originalDefault) await rpc('selectModel', { sessionId, ...originalDefault });
    await rpc('workspace/archiveSession', { sessionId }).catch(() => {});
  }
  if (workspaceId) await rpc('workspace/delete', { workspaceId }).catch(() => {});
  if (fixture) await rm(fixture, { recursive: true, force: true });
  await close();
}
