import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Restored active sessions also display their title in the breadcrumb. */
export function verificationSessionRow(page, title) {
  return page.getByLabel('Sessions', { exact: true }).getByText(title, { exact: true });
}

/** Each service UID needs its own Chromium home, including crashpad and caches. */
export async function launchVerificationBrowser(chromium, { args = [] } = {}) {
  const home = await mkdtemp(join(process.env.DSH_BROWSER_HOME || tmpdir(), 'dsh-browser-check-'));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', ...args],
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache') } });
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
  return { browser, close: async () => {
    try { await browser.close(); }
    finally { await rm(home, { recursive: true, force: true }); }
  } };
}
