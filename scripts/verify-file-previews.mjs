#!/usr/bin/env node
/** Exercise the installed resource adapter in Chromium against a disposable server. */
import assert from 'node:assert/strict';
import { verifyNativeTerminal } from './verify-native-terminal-client.mjs';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const base = process.env.DSH_VERIFY_URL ?? 'http://127.0.0.1:3999';
const profile = process.env.DSH_PROFILE_ROOT ?? '/opt/dsh-seed/profiles/web';
const secret = process.env.DSH_BOOT_TOKEN;
assert.ok(secret, 'Run only against a disposable plugin-boot server');
const require = createRequire(`${profile}/package.json`);
const { chromium } = require('playwright-core');
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
context.setDefaultTimeout(30000);
const page = await context.newPage();
const root = await mkdtemp('/tmp/dsh-preview-check-');
const archive = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
const sessions = [];
const workspaces = [];
const errors = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
let privateAssetRequests = 0;
const localSite = createServer((request, response) => {
  if (request.url === '/asset.png') {
    privateAssetRequests += 1;
    response.setHeader('Content-Type', 'image/png');
    response.end(png);
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Local browser verification</title><body style="margin:0;background:rgb(19,90,150)"><h1 style="margin:40px">LOCAL_BROWSER_OK</h1><img src="/asset.png">');
  }
});
page.on('pageerror', error => errors.push(error.message));
async function rpc(method, request) {
  const response = await context.request.post(`${base}/api/${method}`, { data: {
    type: 'client-request', rpcId: randomUUID(), method, payload: { args: request === undefined ? {} : { request } },
  } });
  assert.equal(response.status(), 200);
  const { result } = await response.json();
  assert.equal(result.ok, true, `${method}: ${result.error?.message}`);
  return result.value;
}
const address = (sessionId, path) => `dsh-resource://file/session/${sessionId}/${path.split('/').map(encodeURIComponent).join('/')}`;
async function open(sessionId, path) {
  await page.evaluate(url => window.__previewTestContext.get('sidebarRight').openResource(url), address(sessionId, path));
}
const image = () => page.locator('[data-image-preview] img:visible');
async function waitForImage(path) {
  await page.waitForFunction(expected => [...document.querySelectorAll('[data-textpreview-url]')]
    .some(view => {
      const img = view.querySelector('[data-image-preview] img');
      return img?.naturalWidth > 0 && img.getClientRects().length > 0 &&
        decodeURIComponent(view.dataset.textpreviewUrl).endsWith(expected);
    }), path);
}
async function select(sessionId) {
  await page.waitForFunction(id => !!window.__previewTestContext?.sessions.list.getSnapshot().byId[id]?.cwd, sessionId);
  await page.evaluate(id => window.__previewTestContext.get('uiWorkspace').openSession(id), sessionId);
  await page.waitForFunction(id => window.__previewTestContext.get('sidebarRight').mounted.getSnapshot() === id, sessionId);
}
function blankPdf() {
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, body] of [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
  ].entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return pdf;
}
try {
  await new Promise(resolve => localSite.listen(0, '127.0.0.1', resolve));
  const localUrl = `http://127.0.0.1:${localSite.address().port}/`;
  for (const folder of ['one', 'two']) {
    await mkdir(`${root}/${folder}`);
    await writeFile(`${root}/${folder}/image #?% ü.png`, png);
    await writeFile(`${root}/${folder}/note.txt`, `PREVIEW_${folder}`);
    await writeFile(`${root}/${folder}/page.html`, '<!doctype html><h1>HTML_PREVIEW_OK</h1><img src="asset.png">');
    await writeFile(`${root}/${folder}/asset.png`, png);
    await writeFile(`${root}/${folder}/archive.zip`, archive);
    await writeFile(`${root}/${folder}/report.pdf`, blankPdf());
  }
  await symlink(`${root}/two/note.txt`, `${root}/one/escape.txt`);
  await context.request.get(`${base}/?token=${encodeURIComponent(secret)}`);
  const inventory = await rpc('pluginInventory/list');
  for (const name of ['dsh-context', 'dsh-favicon-status', 'dsh-local-speech-input',
    'dsh-loop-detector', 'dsh-playwright', 'dsh-plugin-task-notification',
    'dsh-session-pin', 'dsh-ui-appearance', 'dsh-better-sidebar']) {
    assert.ok(inventory.entries.some(row => row.moduleName === name && row.enabled && row.fiberPhase === 'active'),
      `${name} host plugin must mount`);
  }
  const token = inventory.entries.find(row => row.moduleName === '@zoytown/dsh-token');
  assert.equal(token?.enabled, false);
  assert.notEqual(token?.fiberPhase, 'active');
  for (const preset of inventory.agentPresets) assert.equal(preset.broken, undefined, `${preset.id} preset mounts`);
  console.log('All nine enabled host plugins mounted; Token remained unloaded.');
  for (const folder of ['one', 'two']) {
    const { workspace } = await rpc('workspace/create', { path: `${root}/${folder}` });
    workspaces.push(workspace.workspaceId);
    const { sessionId } = await rpc('session/create', { workspaceId: workspace.workspaceId });
    sessions.push(sessionId);
    // Empty drafts do not mount a right sidebar. Materialize a user message,
    // then cancel immediately; this fixture does not depend on model output.
    await rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue',
      content: [{ type: 'text', text: 'File preview verification fixture. Do not use tools.' }] });
    await rpc('session/cancel', { sessionId });
  }
  console.log('Created disposable sessions for file preview verification.');
  // Expose the real plugin context only in this test browser. The served image
  // remains unchanged; all rendering and file requests use installed code.
  await page.route('**/*', async route => {
    if (!route.request().url().includes('dsh-better-sidebar') || !route.request().url().includes('client.js')) return route.continue();
    const response = await route.fetch();
    const source = await response.text();
    const anchor = 'function registerNativeSurface(deps) {';
    assert.equal(source.split(anchor).length, 2, 'test context capture anchor');
    await route.fulfill({ response, body: source.replace(anchor, `${anchor}\nwindow.__previewTestContext = deps.ctx;`) });
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__previewTestContext?.get('sidebarRight'));
  await page.waitForFunction(() => {
    const entries = [...window.__previewTestContext.loader.entries()];
    return ['dsh-better-sidebar', 'dsh-context', 'dsh-favicon-status', 'dsh-local-speech-input',
      'dsh-playwright', 'dsh-session-pin', 'dsh-ui-appearance']
      .every(name => entries.some(entry => entry.options.name === name && entry.fiber?.state === 2));
  });
  const tokenMounted = await page.evaluate(() => [...window.__previewTestContext.loader.entries()]
    .some(entry => entry.options.name === '@zoytown/dsh-token' && entry.fiber?.state === 2));
  assert.equal(tokenMounted, false, 'Token client stays unloaded');
  await page.waitForFunction(id => !!window.__previewTestContext.sessions.list.getSnapshot().byId[id]?.cwd, sessions[0]);
  await select(sessions[0]);
  console.log('Loaded the installed sidebar and referenced session directories.');
  await verifyNativeTerminal(page, sessions[0], sessions[1]);
  const browserState = await page.evaluate(sessionId => window.__previewTestContext.connection.rpc.call(
    '/dsh-playwright', 'state', { sessionId },
  ), sessions[0]);
  assert.equal(browserState.ok, true, browserState.error?.message);
  await page.getByRole('textbox', { name: 'Browser Use address' }).fill(localUrl);
  const navigation = page.waitForResponse(response => response.url().endsWith('/dsh-playwright/navigate'));
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  const navigationResponse = await navigation;
  assert.equal(navigationResponse.status(), 200);
  const navigationResult = (await navigationResponse.json()).result;
  assert.equal(navigationResult.ok, true, navigationResult.error?.message);
  assert.equal(navigationResult.value.url, localUrl);
  assert.ok(navigationResult.value.image.length > 1000, 'live browser screenshot');
  await page.waitForFunction(url => {
    const canvas = document.querySelector(`canvas[aria-label="Live screenshot of ${url}"]`);
    if (!canvas) return false;
    const pixel = canvas.getContext('2d').getImageData(5, 5, 1, 1).data;
    return Math.abs(pixel[0] - 19) < 10 && Math.abs(pixel[1] - 90) < 10 && Math.abs(pixel[2] - 150) < 10;
  }, localUrl);
  assert.ok(privateAssetRequests > 0, 'private subresource loaded');
  console.log('Verified local HTTP navigation, private subresources, screenshots, and the shared Browser Use control panel.');
  await open(sessions[0], 'image #?% ü.png');
  await image().waitFor();
  assert.equal(await image().evaluate(img => img.naturalWidth), 1);
  assert.match(await image().getAttribute('src'), /^blob:/, 'native image renderer uses authenticated bytes');
  await open(sessions[1], 'image #?% ü.png');
  await waitForImage('image #?% ü.png');
  await open(sessions[0], `${root}/one/asset.png`);
  await waitForImage(`${root}/one/asset.png`);
  await select(sessions[1]);
  await open(sessions[0], 'image #?% ü.png');
  await waitForImage('image #?% ü.png');
  await select(sessions[0]);
  await waitForImage(`${root}/one/asset.png`);
  // Native tabs survive a session switch, but upstream does not persist their
  // layout across a full browser reload. Reopen the same resource on a cold UI.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__previewTestContext?.get('sidebarRight'));
  await select(sessions[0]);
  await open(sessions[0], 'image #?% ü.png');
  await waitForImage('image #?% ü.png');
  console.log('Verified real relative/absolute image previews, encoded names, referenced sessions, and restored tabs.');

  await open(sessions[0], 'missing.png');
  await page.locator('[data-textpreview-failed]').waitFor();
  await writeFile(`${root}/one/missing.png`, png);
  await page.locator('[data-textpreview-retry]').click();
  await image().waitFor();
  assert.equal(await image().evaluate(img => img.naturalWidth), 1);
  console.log('Verified missing-image error and Retry recovery.');

  await open(sessions[0], 'note.txt');
  await page.getByText('PREVIEW_one', { exact: true }).waitFor();
  const htmlAsset = page.waitForResponse(response => response.url().includes('/sidebar/html/') && response.url().endsWith('/asset.png'));
  await open(sessions[0], 'page.html');
  const html = page.frameLocator('iframe[src*="/sidebar/html/"]');
  await html.getByRole('heading', { name: 'HTML_PREVIEW_OK' }).waitFor();
  // Upstream's opaque iframe origin is refused by its existing request fence.
  // This patch resolves the document path without relaxing that boundary.
  assert.ok([401, 403].includes((await htmlAsset).status()), 'HTML sandbox origin fence is preserved');
  // All routes retain the server's existing workspace fence, including symlinks.
  for (const path of [`${root}/two/note.txt`, `${root}/one/../two/note.txt`, `${root}/one/escape.txt`]) {
    const response = await context.request.get(`${base}/sidebar/file?${new URLSearchParams({ sessionId: sessions[0], cwd: `${root}/one`, path })}`);
    assert.equal(response.status(), 403, 'workspace containment');
  }
  await open(sessions[0], 'archive.zip');
  const download = page.getByRole('link', { name: /download/i });
  await download.waitFor();
  const response = await context.request.get(new URL(await download.getAttribute('href'), base).href);
  assert.equal(response.status(), 200);
  assert.deepEqual(await response.body(), archive);
  await open(sessions[0], 'report.pdf');
  await page.locator('[data-pdf-preview] canvas').first().waitFor();
  assert.deepEqual(errors, []);
  console.log('Verified text/HTML/PDF/download adapter paths and existing workspace containment.');
} catch (error) {
  console.error(String(error?.stack ?? error).split(secret).join('<redacted>'));
  console.error((await page.locator('body').innerText().catch(() => '')).slice(-4000));
  process.exitCode = 1;
} finally {
  for (const sessionId of sessions) await rpc('workspace/archiveSession', { sessionId }).catch(() => {});
  for (const workspaceId of workspaces) await rpc('workspace/delete', { workspaceId }).catch(() => {});
  await browser.close();
  await new Promise(resolve => localSite.close(resolve));
  await rm(root, { recursive: true, force: true });
}
