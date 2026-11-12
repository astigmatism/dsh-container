#!/usr/bin/env node
/** Check mounted browser integrations; --live also exercises isolated native tools/files. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { launchVerificationBrowser } from './verification-browser.mjs';
const base = process.env.DSH_VERIFY_URL ?? 'http://127.0.0.1:3080';
const profile = process.env.DSH_PROFILE_ROOT ?? '/data/dsh/profiles/web';
const require = createRequire(`${profile}/package.json`);
const secret = process.env.DSH_BOOT_TOKEN ?? (await readFile(process.env.DSH_WEB_LAUNCH_TOKEN_FILE ?? '/run/dsh-backend-auth/launch-token', 'utf8')).trim();
if (process.argv.includes('--live')) {
  process.env.DSH_BOOT_TOKEN = secret;
  process.env.DSH_VERIFY_URL = base;
  process.env.DSH_PROFILE_ROOT = profile;
  await import('./verify-file-previews.mjs');
} else {
  const { chromium } = require('playwright-core');
  const { browser, close } = await launchVerificationBrowser(chromium);
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await context.request.get(`${base}/?token=${encodeURIComponent(secret)}`);
    const response = await context.request.post(`${base}/api/pluginInventory/list`, { data: {
      type: 'client-request', rpcId: randomUUID(), method: 'pluginInventory/list', payload: { args: {} },
    } });
    assert.equal(response.status(), 200, 'live plugin inventory');
    const { result } = await response.json();
    assert.equal(result.ok, true, result.error?.message);
    const maintained = new Set(['dsh-context', 'dsh-favicon-status', 'dsh-speech-whisper',
      'dsh-loop-detector', 'dsh-ego-browser', 'dsh-plugin-task-notification',
      'dsh-session-pin', 'dsh-ui-appearance', 'dsh-better-sidebar', 'dsh-follow-up-suggestions',
      'dsh-portal-wallpapers']);
    for (const row of result.value.entries) {
      if (!row.enabled) continue; // Explicitly disabled user plugins stay disabled.
      if (maintained.has(row.moduleName) || /dsh-(web-search-free|router-model-discovery)\.js$/.test(row.moduleName ?? '')) {
        assert.equal(row.fiberPhase, 'active', `${row.moduleName} failed to mount in the deployed profile`);
      }
    }
    if (process.env.DSH_TOKEN_ENABLED !== 'true') {
      const token = result.value.entries.find(row => row.moduleName === '@zoytown/dsh-token');
      assert.notEqual(token?.enabled, true, 'default Token policy');
      assert.notEqual(token?.fiberPhase, 'active');
    }
    for (const preset of result.value.agentPresets) assert.equal(preset.broken, undefined, `${preset.id} preset failed to mount`);

    const loaded = await page.goto(base, { waitUntil: 'domcontentloaded' });
    assert.ok(loaded?.ok(), 'authenticated browser document');
    await page.waitForFunction(() => typeof window.__ModuleLoader__ === 'object');
    await page.locator('[data-composer-input]').first().waitFor();
    // Voice input: the retired DOM-patched microphone must be gone everywhere.
    // The replacement lives in the composer's activity slot, which the app only
    // renders inside an open Session, so its positive assertions run where a
    // Session exists (verify-dictation-roundtrip.mjs, verify-dictation-client.mjs).
    assert.equal(await page.locator('[data-local-speech-button]').count(), 0, 'the retired microphone is still mounted');
    await page.locator('style[data-plugin="dsh-ui-appearance"]').waitFor({ state: 'attached' });
    // Follow-up suggestions: browser half installed, Host preference route answering.
    await page.locator('#dsh-follow-up-suggestions-style').waitFor({ state: 'attached' });
    const preference = await page.evaluate(async () => {
      const reply = await fetch('/api/follow-up-suggestions/preference', { cache: 'no-store' });
      return { status: reply.status, body: await reply.json() };
    });
    assert.equal(preference.status, 200, 'follow-up suggestion preference route');
    assert.equal(preference.body.ok, true);
    assert.equal(typeof preference.body.enabled, 'boolean');
    // Service Portal wallpapers: browser half installed, and its queue route
    // answering as this plugin's. There is no portal to reach in here, so what
    // proves ownership is that the route is not a 404 or a routing failure.
    await page.locator('#dsh-portal-wallpapers-style').waitFor({ state: 'attached' });
    const queue = await page.evaluate(async () => {
      const reply = await fetch('/api/portal-wallpapers/queue', { cache: 'no-store' });
      return { status: reply.status, body: await reply.json().catch(() => null) };
    });
    // The queue answers 200 and carries its own trouble, so this holds whether
    // or not a portal is reachable from here — what is being proven is that the
    // route belongs to the plugin and answers, rather than 404ing.
    assert.equal(queue.status, 200, 'wallpaper queue route answers');
    assert.equal(typeof queue.body?.ok, 'boolean', 'wallpaper queue route answer');
    assert.equal(queue.body?.ok === true, Array.isArray(queue.body?.queued), 'wallpaper queue answer shape');
    assert.deepEqual(errors, []);
    console.log('Verified enabled plugin and preset mounts, composed chat, speech, appearance and follow-up suggestion browser integrations. Native terminal lifecycle is covered by the isolated --live gate.');
  } catch (error) {
    console.error(String(error?.stack ?? error).split(secret).join('<redacted>'));
    process.exitCode = 1;
  } finally { await close(); }
}
