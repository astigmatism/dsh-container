/** Synthetic microphone -> actual HTTPS gateway -> fixture STT -> actual composer. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { launchVerificationBrowser } from './verification-browser.mjs';

assert.ok(process.env.DSH_BOOT_TOKEN, 'Run only against a disposable boot fixture');
const temporary = await mkdtemp('/tmp/dsh-dictation-roundtrip-');
let failure = false, received = 0;
const stt = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  assert.equal(req.headers.authorization, 'Bearer synthetic-speech-key');
  assert.match(req.headers['content-type'], /^multipart\/form-data;/);
  assert.ok(Buffer.concat(chunks).length > 500, 'real MediaRecorder audio upload');
  received++;
  res.writeHead(failure ? 503 : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(failure ? { error: { message: 'Synthetic STT unavailable' } } : { text: 'Synthetic microphone round trip succeeded.' }));
});
await new Promise(resolve => stt.listen(0, '127.0.0.1', resolve));
async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
const httpsPort = await freePort(), httpPort = await freePort();
await writeFile(temporary + '/backend-token', process.env.DSH_BOOT_TOKEN, { mode: 0o600 });
await writeFile(temporary + '/stt-key', 'synthetic-speech-key', { mode: 0o600 });
const gateway = spawn(process.execPath, ['/opt/dsh-qualification/gateway/server.mjs'], { env: { ...process.env,
  HARNESS_GATEWAY_DATA_DIR: temporary + '/gateway', HARNESS_BACKEND_URL: process.env.DSH_VERIFY_URL,
  HARNESS_BACKEND_TOKEN_FILE: temporary + '/backend-token', HARNESS_HTTPS_PORT: String(httpsPort),
  HARNESS_HTTP_PORT: String(httpPort), HARNESS_PUBLIC_HTTPS_PORT: String(httpsPort), HARNESS_PUBLIC_HTTP_PORT: String(httpPort),
  HARNESS_AUTH_USERNAME: 'synthetic-user', HARNESS_AUTH_PASSWORD: 'synthetic-dictation-password',
  HARNESS_TLS_MODE: 'auto', HARNESS_TLS_IP: '127.0.0.1', HARNESS_TLS_DNS: 'localhost',
  STT_BASE_URL: `http://127.0.0.1:${stt.address().port}/v1`, STT_API_KEY_FILE: temporary + '/stt-key', STT_MAX_RECORD_SECONDS: '5',
}, stdio: ['ignore', 'ignore', 'pipe'] });
let logs = ''; gateway.stderr.on('data', chunk => logs += chunk);
let close;
try {
  const require = createRequire(`${process.env.DSH_PROFILE_ROOT}/package.json`);
  const launched = await launchVerificationBrowser(require('playwright-core').chromium, { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  close = launched.close;
  const context = await launched.browser.newContext({ ignoreHTTPSErrors: true, permissions: ['microphone'] });
  const base = `https://127.0.0.1:${httpsPort}`;
  const deadline = Date.now() + 30000;
  while (true) {
    try { await context.request.get(base); break; } catch {
      assert.ok(gateway.exitCode === null && Date.now() < deadline, `fixture gateway ready: ${logs}`); await delay(200);
    }
  }
  const unauthorized = await context.request.post(base + '/local-stt/transcriptions', { multipart: { file: { name: 'fixture.webm', mimeType: 'audio/webm', buffer: Buffer.from('fixture') } } });
  assert.ok([401, 403].includes(unauthorized.status()));
  const page = await context.newPage();
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__fixtureTracks = [];
    navigator.mediaDevices.getUserMedia = async options => { const stream = await original(options); window.__fixtureTracks.push(...stream.getTracks()); return stream; };
  });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('#username').fill('synthetic-user'); await page.locator('#password').fill('synthetic-dictation-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  async function rpc(method, request) {
    const response = await context.request.post(base + '/api/' + method, { data: {
      type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request } },
    } });
    const { result } = await response.json(); assert.equal(result.ok, true, result.error?.message); return result.value;
  }
  const { workspace } = await rpc('workspace/create', { path: temporary });
  const { sessionId } = await rpc('session/create', { workspaceId: workspace.workspaceId });
  await rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue',
    content: [{ type: 'text', text: 'Disposable dictation fixture. Do not use tools.' }] });
  await rpc('session/cancel', { sessionId });
  const title = 'Synthetic dictation verification';
  await rpc('session/rename', { sessionId, title });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const group = page.getByRole('treeitem').filter({ has: page.getByText(workspace.title, { exact: true }) }).first();
  const sessionRow = page.getByText(title, { exact: true });
  const navigationDeadline = Date.now() + 30000;
  while (!(await sessionRow.isVisible())) {
    assert.ok(Date.now() < navigationDeadline, 'dictation fixture conversation is visible');
    if (await group.getAttribute('aria-expanded') === 'false') await group.getByText(workspace.title, { exact: true }).click();
    await delay(100);
  }
  await sessionRow.click();
  const button = page.locator('[data-local-speech-button]');
  const composer = page.locator('[data-composer-input][contenteditable="true"]').first();
  await button.waitFor(); await composer.fill('');
  for (const fail of [false, true]) {
    failure = fail;
    const previous = await composer.textContent();
    await button.click(); await page.locator('[data-local-speech-button][data-state="recording"]').waitFor();
    await delay(800); await button.click();
    await page.locator(`[data-local-speech-button][data-state="${fail ? 'error' : 'idle'}"]`).waitFor();
    await page.waitForFunction(() => window.__fixtureTracks.length > 0 && window.__fixtureTracks.every(track => track.readyState === 'ended'));
    if (fail) { assert.equal(await composer.textContent(), previous); assert.match(await button.getAttribute('title'), /Synthetic STT unavailable/); }
    else assert.match(await composer.textContent(), /Synthetic microphone round trip succeeded\./);
  }
  assert.equal(received, 2);
  await page.evaluate(() => {
    const original = window.MediaRecorder;
    window.MediaRecorder = class extends original { constructor() { throw new Error('Synthetic recorder failure'); } };
  });
  await button.click();
  await page.waitForFunction(() => document.querySelector('[data-local-speech-button]')?.title === 'Synthetic recorder failure');
  await page.waitForFunction(() => window.__fixtureTracks.length >= 3 && window.__fixtureTracks.every(track => track.readyState === 'ended'));
  assert.equal(received, 2, 'failed recorder does not send audio');
  console.log('Verified synthetic microphone capture through authenticated HTTPS gateway, STT response insertion, failure presentation and microphone track cleanup.');
} finally {
  await close?.(); gateway.kill('SIGTERM');
  await Promise.race([new Promise(resolve => gateway.once('exit', resolve)), delay(5000)]);
  if (gateway.exitCode === null) gateway.kill('SIGKILL');
  await new Promise(resolve => stt.close(resolve)); await rm(temporary, { recursive: true, force: true });
}
