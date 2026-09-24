#!/usr/bin/env node
/** Check mounted browser integrations; --live also exercises isolated native tools/files. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
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
    await context.request.get(`${base}/?token=${encodeURIComponent(secret)}`);
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.locator('[data-composer-input]').first().waitFor();
    await page.locator('[data-local-speech-button]').first().waitFor();
    assert.ok(await page.locator('style[data-plugin="dsh-ui-appearance"]').count());
    assert.deepEqual(errors, []);
    console.log('Verified composed chat, speech and appearance browser integrations. Native terminal lifecycle is covered by the isolated --live gate.');
  } catch (error) {
    console.error(String(error?.stack ?? error).split(secret).join('<redacted>'));
    process.exitCode = 1;
  } finally { await browser.close(); }
}
