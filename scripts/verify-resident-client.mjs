/** Deployment gate for the real model catalog, picker, effort control and inference. */
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { readSettings, residentClientExpectations } from './verify-router-contract.mjs';
import { launchVerificationBrowser, verificationSessionRow } from './verification-browser.mjs';
import { installVerificationOnboarding, clickVerificationTarget } from './verification-onboarding.mjs';
import { verificationPrompt } from './verification-inference.mjs';

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
let defaultSnapshot;
let lastVerificationDefault;
let fixture;
let workspaceId;
async function rpc(name, request = {}) {
  const method = name.includes('/') ? name : `session/${name}`;
  const response = await context.request.post(`${base}/api/${method}`, { data: {
    type: 'client-request', rpcId: randomUUID(), method,
    payload: { args: name.startsWith('settings/') ? request : name === 'modelCatalog' ? {} : name === 'list' ? { _request: request } : { request } },
  } });
  assert.equal(response.status(), 200, `${name}: HTTP status`);
  const { result } = await response.json();
  assert.equal(result.ok, true, `${name}: ${result.error?.message}`);
  return result.value;
}
function compareCatalog(expected, catalog) {
  for (const row of expected) {
    const group = catalog.groups.find(group => group.id === row.provider);
    assert.ok(group, `${row.provider} is represented`);
    assert.equal(catalog.failures.some(f => f.id === row.provider), false);
    assert.equal(catalog.routableProviders.includes(row.provider), row.available);
    assert.deepEqual(group.models.map(model => ({ id: model.id, name: model.name, available: model.available !== false })),
      [{ id: row.model, name: row.name, available: row.available }]);
    if (row.available) assert.equal(group.models[0].reasoning?.defaultEffort, row.reasoningEffort);
  }
}
/** The router may change state while this runs (docs/llm-router-contract.md):
 * wait until persisted states, the router and the served catalog agree. */
async function settledExpectations() {
  const deadline = Date.now() + 120000;
  const notices = new Set();
  for (;;) {
    try {
      const expected = await residentClientExpectations(await readSettings(settingsPath), { live, log: notice => notices.add(notice) });
      // Offline fixtures have no router: discovery must still record a state for both models.
      if (!live) assert.ok(expected.every(row => row.recorded), 'discovery has recorded each resident state');
      const catalog = await rpc('modelCatalog');
      compareCatalog(expected, catalog);
      for (const notice of notices) console.log(notice);
      return { expected, catalog };
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      notices.clear();
      await delay(2000);
    }
  }
}
try {
  await installVerificationOnboarding(page, base);
  await context.request.get(`${base}/?token=${encodeURIComponent(secret)}`);
  const { expected, catalog } = await settledExpectations();
  originalDefault = catalog.default;
  defaultSnapshot = (await rpc('settings/describe')).namespaces.find(row => row.ns === 'agent-default-model');
  const available = expected.filter(row => row.available);
  // A switching router accepts selection but makes requests wait; only
  // available models answer the live inference check.
  const servable = available.filter(row => row.status === 'available');
  if (!available.length) console.log(`No resident model is selectable (${expected.map(row => row.name).join(', ')}); selection, effort and inference checks are skipped.`);
  else if (live && servable.length < available.length) console.log('A switching router is not asked for inference; its requests would wait.');
  fixture = await mkdtemp('/tmp/dsh-resident-verification-');
  const created = await rpc('workspace/create', { path: fixture });
  workspaceId = created.workspace.workspaceId;
  ({ sessionId } = await rpc('create', { workspaceId }));
  const first = available[0];
  if (first) lastVerificationDefault = (await rpc('selectModel', { sessionId, provider: first.provider, model: first.model, reasoningEffort: first.reasoningEffort })).selected;
  // The sidebar omits empty drafts. Materialize this isolated conversation
  // before opening its session-specific model controls. Offline image tests
  // intentionally have no inference endpoint; only live mode requires replies.
  const opening = 'Text-only verification. Do not use tools or access files. Reply with READY.';
  if (live && first?.status === 'available') await verificationPrompt({ rpc, sessionId, text: opening });
  else {
    await rpc('prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: opening }] });
    await rpc('cancel', { sessionId });
  }
  const readyDeadline = Date.now() + (live ? 600000 : 90000);
  while ((await rpc('list')).items.find(item => item.sessionId === sessionId)?.running) {
    assert.ok(Date.now() < readyDeadline, 'verification session reached idle');
    await delay(1000);
  }
  const title = `Resident model verification ${sessionId.slice(-8)}`;
  await rpc('rename', { sessionId, title });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  const group = page.getByRole('treeitem').filter({ has: page.getByText(created.workspace.title, { exact: true }) }).first();
  const sessionRow = verificationSessionRow(page, title);
  // Workspace restoration can expand the most recent group while the browser
  // connects. Re-read its state instead of racing that restoration with one
  // blind toggle, and click the label rather than the row's action buttons.
  const navigationDeadline = Date.now() + 30000;
  while (true) {
    assert.ok(Date.now() < navigationDeadline, 'verification session is accessible in its workspace');
    try {
      if (await sessionRow.isVisible()) { await clickVerificationTarget(page, sessionRow, { timeout: 500 }); break; }
      if (await group.count() && await group.getAttribute('aria-expanded') === 'false') {
        await clickVerificationTarget(page, group.getByText(created.workspace.title, { exact: true }), { timeout: 500 });
      }
    } catch (error) { if (error.name !== 'TimeoutError') throw error; }
    await delay(100);
  }
  await page.waitForSelector('[data-composer-input]');
  const trigger = page.getByRole('button', { name: /^Select model/ });
  await clickVerificationTarget(page, trigger);
  await clickVerificationTarget(page, page.getByRole('menuitem', { name: /^Model/ }));
  for (const row of expected) {
    const option = page.getByRole('menuitemradio', { name: row.name, exact: true });
    await option.waitFor();
    assert.equal(await option.isDisabled(), !row.available);
  }
  await clickVerificationTarget(page, trigger);
  if (first) {
    await clickVerificationTarget(page, trigger);
    await clickVerificationTarget(page, page.getByRole('menuitem', { name: /^Effort/ }));
    assert.deepEqual(await page.getByRole('menuitemradio').allTextContents(), ['Off', 'Minimal', 'Low', 'Medium', 'High', 'Xhigh', 'Max']);
    await clickVerificationTarget(page, trigger);
  }
  console.log(`Live Harness catalog and rendered picker include ${expected.map(row => row.name).join(' and ')}, with a separate effort control.`);
  // Model selection saves the next-request preference asynchronously. Verify
  // both choices and distinct reasoning settings survive browser reconnection.
  for (const [index, choice] of available.entries()) {
    const selection = { provider: choice.provider, model: choice.model, reasoningEffort: index ? 'high' : 'off' };
    assert.deepEqual((await rpc('selectModel', { sessionId, ...selection })).selected, selection);
    lastVerificationDefault = selection;
    const deadline = Date.now() + 15000;
    while (!isDeepStrictEqual((await rpc('modelCatalog')).default, selection)) {
      assert.ok(Date.now() < deadline, 'model and reasoning default persisted'); await delay(100);
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-composer-input]');
    assert.deepEqual((await rpc('modelCatalog')).default, selection);
  }
  console.log('Available model selections and separate reasoning preferences survived browser reconnection.');
  if (live) {
    for (const [index, choice] of servable.entries()) {
      lastVerificationDefault = (await rpc('selectModel', { sessionId, provider: choice.provider, model: choice.model, reasoningEffort: 'medium' })).selected;
      const marker = `RESIDENT_${index}_${randomUUID().slice(0, 8)}`;
      await verificationPrompt({ rpc, sessionId, expectedText: marker, text:
        `Text-only model acceptance check. Do not use tools or access files. Reply with exactly ${marker} and no other text.` });
      const meter = page.getByRole('button', { name: /% of context used/ });
      await clickVerificationTarget(page, meter);
      const capacity = `${Math.round(choice.contextWindow / 1000)}K`; // Upstream meter uses decimal K.
      await page.getByRole('dialog').filter({ hasText: new RegExp(`/ ${capacity}`) }).waitFor();
      await page.keyboard.press('Escape');
      console.log(`${choice.name}: live application inference and durable session continuation passed.`);
    }
  }
} catch (error) {
  console.error(String(error?.stack ?? error).split(secret).join('<redacted>'));
  process.exitCode = 1;
} finally {
  if (sessionId) {
    await rpc('cancel', { sessionId }).catch(() => {});
    // Restore raw user-layer fields, including an unavailable default. Do not
    // overwrite a concurrent user's choice or route through selectModel here.
    if (defaultSnapshot && lastVerificationDefault) {
      const current = (await rpc('modelCatalog')).default;
      if (isDeepStrictEqual(current, lastVerificationDefault)) {
        await rpc('settings/mutate', { ns: 'agent-default-model', ops:
          ['provider', 'model', 'reasoningEffort'].map(key => Object.hasOwn(defaultSnapshot.user ?? {}, key)
            ? { op: 'set', path: [key], value: defaultSnapshot.user[key] } : { op: 'unset', path: [key] }) });
      }
    }
    await rpc('workspace/archiveSession', { sessionId }).catch(() => {});
  }
  if (workspaceId) await rpc('workspace/delete', { workspaceId }).catch(() => {});
  if (fixture) await rm(fixture, { recursive: true, force: true });
  await page.unrouteAll({ behavior: 'wait' });
  await close();
}
