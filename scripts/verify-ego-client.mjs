import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

/** Real registered ego tools, Chromium and the native Sidebar in a disposable home. */
export async function verifyEgoClient({ page, context, base, sessions, select, root }) {
  let assets = 0;
  const site = createServer((req, res) => {
    if (req.url === '/asset') { assets++; res.end('asset'); return; }
    if (req.url === '/download') { res.setHeader('content-disposition', 'attachment; filename="fixture.txt"'); res.end('EGO_DOWNLOAD_OK'); return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: '/one' }); res.end(); return; }
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>Ego fixture ${req.url}</title><body style="margin:0;height:2200px;background:#eee">
      <input id="input" style="position:absolute;left:40px;top:40px;width:200px;height:40px"><button id="click" style="position:absolute;left:40px;top:100px;width:200px;height:40px" onclick="this.textContent='CLICKED'">Click</button>
      <a id="download" href="/download" style="position:absolute;top:180px">Download</a><canvas width="400" height="200" style="position:absolute;top:250px"></canvas>
      <script>const c=document.querySelector('canvas').getContext('2d'); c.fillStyle='white';c.fillRect(0,0,400,200);c.fillStyle='blue';c.beginPath();c.arc(100,100,60,0,Math.PI*2);c.fill();fetch('/asset');</script>`);
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${site.address().port}`;
  async function call(sessionId, name, args = {}, extra = {}) {
    const response = await context.request.post(`${base}/qualification/ego`, { data: { sessionId, name, args, ...extra }, timeout: 90000 });
    const result = await response.json();
    assert.equal(response.status(), 200, `${name}: ${result.error}`);
    assert.notEqual(result.value.ok, false, `${name}: ${JSON.stringify(result.value)}`);
    return result;
  }
  const js = async (id, expression) => (await call(id, 'ego_js', { expression })).value.result;
  async function openTab(id) {
    await select(id);
    await page.evaluate(sessionId => window.__previewTestContext.get('betterSidebar').openTab({ type: 'ego-browser:watch' }, { sessionId }), id);
    await page.locator('.dsh-ego-side-root:visible').waitFor();
  }
  const live = () => page.locator('.dsh-ego-side-root:visible .dsh-ego-side-liveimg');
  async function frame() {
    await page.waitForFunction(() => [...document.querySelectorAll('.dsh-ego-side-liveimg')].some(img => img.getClientRects().length && img.naturalWidth > 0), null, { timeout: 45000 });
  }
  try {
    await Promise.all([
      call(sessions[0], 'ego_navigate', { url: url + '/redirect' }),
      call(sessions[1], 'ego_navigate', { url: url + '/two' }),
    ]);
    for (let i = 0; i < 3; i++) {
      const results = await Promise.all(sessions.map(id => js(id, 'location.pathname')));
      assert.deepEqual(results, ['/one', '/two'], 'concurrent conversations retain distinct active tabs');
    }
    assert.ok(assets >= 2, 'private subresources use the configured allow policy');
    await js(sessions[0], "document.cookie='fixtureLogin=shared; Max-Age=3600; path=/';localStorage.setItem('fixtureLogin','shared');true");
    assert.equal(await js(sessions[1], "document.cookie.includes('fixtureLogin=shared') && localStorage.getItem('fixtureLogin') === 'shared'"), true);
    const shot = await call(sessions[0], 'ego_screenshot', { selector: 'canvas' });
    assert.ok(shot.content.some(block => block.type === 'image' && block.attachment), 'native image attachment survives tool rendering');
    assert.deepEqual((await readFile(shot.value.path)).subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
    await openTab(sessions[0]); await frame();
    await page.locator('.dsh-ego-side-root:visible .dsh-ego-side-tab[title$="/one"]').waitFor();
    assert.equal(await page.locator('.dsh-ego-side-root:visible .dsh-ego-side-tab[title$="/two"]').count(), 0);
    await call(sessions[1], 'ego_navigate', { url: url + '/other-conversation' });
    await delay(1500);
    assert.equal(await page.locator('.dsh-ego-side-root:visible .dsh-ego-side-tab[title$="/other-conversation"]').count(), 0, 'SSE cannot replace the visible conversation workspace');
    const viewport = await js(sessions[0], '({width:innerWidth,height:innerHeight})');
    const bounds = await live().boundingBox();
    assert.ok(bounds);
    const point = (x, y) => ({ x: bounds.x + x / viewport.width * bounds.width, y: bounds.y + y / viewport.height * bounds.height });
    const input = point(100, 60);
    await page.mouse.click(input.x, input.y); await page.keyboard.type('MANUAL_EGO');
    const deadline = Date.now() + 10000;
    while (await js(sessions[0], "document.querySelector('#input').value") !== 'MANUAL_EGO') {
      assert.ok(Date.now() < deadline, 'manual keyboard input reaches the page'); await delay(200);
    }
    const button = point(100, 120);
    await page.mouse.click(button.x, button.y);
    assert.equal(await js(sessions[0], "document.querySelector('#click').textContent"), 'CLICKED');
    const download = await call(sessions[0], 'ego_download', { triggerSelector: '#download', savePath: root + '/ego-download.txt' });
    assert.equal(await readFile(download.value.path, 'utf8'), 'EGO_DOWNLOAD_OK');
    await openTab(sessions[1]); await frame();
    await page.locator('.dsh-ego-side-root:visible .dsh-ego-side-tab[title$="/other-conversation"]').waitFor();
    await page.reload({ waitUntil: 'networkidle' });
    await openTab(sessions[0]); await frame();
    const start = Date.now();
    const cancelled = await context.request.post(`${base}/qualification/ego`, { data: { sessionId: sessions[0], name: 'ego_wait', args: { ms: 30000 }, abortAfterMs: 500 }, timeout: 15000 });
    assert.equal(cancelled.status(), 500); assert.ok(Date.now() - start < 12000, 'cancellation settles the subprocess');
    assert.equal(await js(sessions[0], 'location.pathname'), '/one', 'tool execution recovers after cancellation');
    await call(sessions[0], 'ego_auth_flush');
    await writeFile(resolve(process.env.DSH_PROFILE_ROOT, '../../ego-browser/qualification.json'), JSON.stringify({ port: site.address().port, sessionId: sessions[0] }));
    console.log('Verified ego tools, concurrent conversation tabs, shared fixture login, screenshot attachments, live Sidebar frames, manual input, download and reconnect/cancellation.');
  } finally { await new Promise(resolve => site.close(resolve)); }
}
