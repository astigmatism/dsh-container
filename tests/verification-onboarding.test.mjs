import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { installVerificationOnboarding, clickVerificationTarget } from '../scripts/verification-onboarding.mjs';
import { verificationSessionRow } from '../scripts/verification-browser.mjs';

let chromium;
try {
  ({ chromium } = createRequire(`${process.env.DSH_TEST_PROFILE_ROOT ?? '/opt/dsh-seed/profiles/web'}/package.json`)('playwright-core'));
} catch (error) {
  if (process.env.DSH_TEST_HARNESS === '1') throw error;
}

for (const credentials of [false, true]) for (const alreadyVisible of [false, true]) {
  test(`${alreadyVisible ? 'visible' : 'late'} ${credentials ? 'credential' : 'preview'} notice cannot block verification or change saved settings`, { skip: !chromium }, async t => {
    let mutations = 0;
    const original = { ns: 'ui-settings-general', revision: 1,
      value: { welcomeNoticeVersion: 'old', unrelated: true }, user: { welcomeNoticeVersion: 'old' } };
    const title = credentials ? 'Add an API key to get started' : 'Preview Notice';
    const button = credentials ? 'Configure later' : 'Continue';
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/api/')) {
        if (req.url.endsWith('/mutate')) mutations++;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ result: { ok: true, value: { namespaces: [original] } } }));
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(`<nav aria-label="Sessions"><button id="target" disabled onclick="this.textContent='Clicked'">Target</button></nav>
        <nav aria-label="Session hierarchy"><span>Target</span></nav>
        <dialog aria-label="${title}"><button id="dismiss">${button}</button></dialog>
        <script>
        dismiss.onclick=async()=>{
          ${credentials ? '' : `await fetch('/api/settings/mutate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({rpcId:'fixture',payload:{args:{ns:'ui-settings-general',ops:[{op:'set',path:['welcomeNoticeVersion'],value:'new'}]}}})});`}
          document.querySelector('dialog').close();
        };
        window.showLateNotice=()=>{setTimeout(()=>document.querySelector('dialog').showModal(),50);setTimeout(()=>target.disabled=false,150)};
        </script>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const home = await mkdtemp(join(tmpdir(), 'dsh-onboarding-test-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const browser = await chromium.launch({ executablePath: process.env.DSH_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
      headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache') } });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await installVerificationOnboarding(page, base);
    await page.goto(base);
    assert.equal(await page.getByRole('dialog').isVisible(), false);
    await page.evaluate(visible => {
      if (visible) {
        document.querySelector('dialog').showModal();
        document.querySelector('#target').disabled = false;
      } else window.showLateNotice();
    }, alreadyVisible);
    assert.equal(await page.getByText('Target', { exact: true }).count(), 2, 'active session also has a breadcrumb');
    const sessionRow = verificationSessionRow(page, 'Target');
    assert.equal(await sessionRow.isVisible(), true, 'navigation remains unique when the session is already restored');
    await clickVerificationTarget(page, sessionRow, { timeout: 5000 });
    assert.equal(await page.getByRole('button', { name: 'Clicked', exact: true }).count(), 1);
    assert.equal(mutations, 0, 'acknowledgement must never reach persisted settings');
    const response = await page.request.post(`${base}/api/settings/describe`);
    assert.deepEqual((await response.json()).result.value.namespaces[0], original);
    await page.unrouteAll({ behavior: 'wait' });
  });
}
