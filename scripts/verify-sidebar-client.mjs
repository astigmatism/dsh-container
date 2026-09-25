#!/usr/bin/env node
/** Check mounted browser integrations; --live also exercises isolated native tools/files. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
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
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'], env: { ...process.env, HOME: '/tmp' } });
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
    const maintained = new Set(['dsh-context', 'dsh-favicon-status', 'dsh-local-speech-input',
      'dsh-loop-detector', 'dsh-playwright', 'dsh-plugin-task-notification',
      'dsh-session-pin', 'dsh-ui-appearance', 'dsh-better-sidebar']);
    for (const row of result.value.entries) {
      if (!row.enabled) continue; // Explicitly disabled user plugins stay disabled.
      if (maintained.has(row.moduleName) || /dsh-(web-search-free|router-model-discovery)\.js$/.test(row.moduleName ?? '')) {
        assert.equal(row.fiberPhase, 'active', `${row.moduleName} failed to mount in the deployed profile`);
      }
    }
    if (process.env.DSH_TOKEN_ENABLED !== 'true') {
      const token = result.value.entries.find(row => row.moduleName === '@zoytown/dsh-token');
      assert.equal(token?.enabled, false, 'default Token policy');
      assert.notEqual(token?.fiberPhase, 'active');
    }
    for (const preset of result.value.agentPresets) assert.equal(preset.broken, undefined, `${preset.id} preset failed to mount`);

    const loaded = await page.goto(base, { waitUntil: 'networkidle' });
    assert.ok(loaded?.ok(), 'authenticated browser document');
    assert.equal(await page.evaluate(() => typeof window.__ModuleLoader__), 'object');
    await page.locator('[data-composer-input]').first().waitFor();
    await page.locator('[data-local-speech-button]').first().waitFor();
    assert.ok(await page.locator('style[data-plugin="dsh-ui-appearance"]').count());
    assert.deepEqual(errors, []);
    console.log('Verified enabled plugin and preset mounts, composed chat, speech and appearance browser integrations. Native terminal lifecycle is covered by the isolated --live gate.');
  } catch (error) {
    console.error(String(error?.stack ?? error).split(secret).join('<redacted>'));
    process.exitCode = 1;
  } finally { await browser.close(); }
}
