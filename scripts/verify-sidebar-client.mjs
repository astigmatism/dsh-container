#!/usr/bin/env node
/** Opt-in end-to-end check of agent terminals through the real Web UI. */
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const live = process.argv.includes('--live');
const base = process.env.DSH_VERIFY_URL ?? 'http://127.0.0.1:3080';
const profile = process.env.DSH_PROFILE_ROOT ?? '/data/dsh/profiles/web';
const require = createRequire(`${profile}/package.json`);
const { chromium } = require('playwright-core');
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'], env: { ...process.env, HOME: '/tmp' } });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let secret = '';
let sessionId;
let otherSessionId;
let uuid;
let workspaceId;
let fixture;

async function rpc(name, request = {}) {
  const method = name.includes('/') ? name : `session/${name}`;
  const response = await context.request.post(`${base}/api/${method}`, { data: {
    type: 'client-request', rpcId: randomUUID(), method,
    payload: { args: name === 'list' ? { _request: request } : { request } },
  } });
  assert.equal(response.status(), 200, `${name} HTTP status`);
  const { result } = await response.json();
  assert.equal(result.ok, true, `${name}: ${result.error?.message}`);
  return result.value;
}
async function sidebar(method, data = {}) {
  const response = await context.request.post(`${base}/sidebar/api/${method}`, { data, headers: { origin: base } });
  assert.equal(response.status(), 200, `${method} HTTP status`);
  const body = await response.json();
  assert.equal(body.ok, true, `${method}: ${body.error?.message}`);
  return body.value ?? body.result ?? body.data;
}
async function subscribeList(id, key) {
  await page.evaluate(({ id, key }) => {
    const url = new URL(`/sidebar/ws/agent-terminals?sessionId=${encodeURIComponent(id)}`, location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url);
    window.__sidebarCheck ??= {};
    const state = window.__sidebarCheck[key] = { ws, list: null };
    ws.onmessage = event => { state.list = JSON.parse(event.data); };
  }, { id, key });
  await page.waitForFunction(key => Array.isArray(window.__sidebarCheck[key].list), key);
}
async function attachTerminal(id, key) {
  await page.evaluate(({ id, key }) => {
    const url = new URL(`/sidebar/ws/terminal?uuid=${encodeURIComponent(id)}`, location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url);
    const state = window.__sidebarCheck[key] = { ws, text: '', chunks: [] };
    ws.onmessage = event => {
      state.text += event.data;
      state.chunks.push({ time: Date.now(), text: event.data });
    };
  }, { id, key });
  await page.waitForFunction(key => window.__sidebarCheck[key].ws.readyState === WebSocket.OPEN, key);
}
async function outputContains(key, text, timeout = 30000) {
  await page.waitForFunction(({ key, text }) => window.__sidebarCheck[key].text.includes(text), { key, text }, { timeout });
}
async function input(text) {
  await page.evaluate(text => window.__sidebarCheck.terminal.ws.send(text), text);
}

try {
  if (process.env.DSH_VERIFY_GATEWAY_PASSWORD) {
    secret = process.env.DSH_VERIFY_GATEWAY_PASSWORD;
    const response = await context.request.post(`${base}/__harness/login`, { form: {
      username: process.env.DSH_VERIFY_GATEWAY_USERNAME, password: secret,
    } });
    assert.ok(response.ok(), 'gateway authentication');
  } else {
    secret = (await readFile(process.env.DSH_WEB_LAUNCH_TOKEN_FILE ?? '/run/dsh-backend-auth/launch-token', 'utf8')).trim();
    await context.request.get(`${base}/?token=${encodeURIComponent(secret)}`);
  }
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-composer-input]');
  assert.equal(await page.locator('[data-local-speech-button]').count(), 1, 'dictation still mounted');
  assert.equal(await page.getByText('Browser Use', { exact: true }).count(), 1, 'existing browser panel still mounted');
  assert.ok(await page.locator('style[data-plugin="dsh-ui-appearance"]').count(), 'appearance customization still loaded');
  const dependencies = await sidebar('terminal.deps');
  assert.equal(dependencies.ok, true, 'native terminal available in live server');
  const prefs = await sidebar('settings.get');
  assert.ok(prefs.value, 'sidebar preferences available');
  assert.equal(errors.length, 0, 'browser module initialization');
  if (!live) {
    console.log('Verified sidebar API, native dependency, chat, and dictation client.');
  } else {
    assert.equal(prefs.value.agentTerminalTools, true, 'agent terminal tools enabled');
    fixture = await mkdtemp('/tmp/dsh-console-check-');
    await writeFile(`${fixture}/fixture.txt`, 'Live console file activity fixture.\n');
    const created = await rpc('workspace/create', { path: fixture });
    workspaceId = created.workspace.workspaceId;
    assert.ok(workspaceId, 'verification workspace registered');
    ({ sessionId } = await rpc('create', { workspaceId }));
    const title = `Live console verification ${sessionId.slice(-8)}`;
    await rpc('rename', { sessionId, title });
    ({ sessionId: otherSessionId } = await rpc('create', { cwd: '/tmp' }));
    const command = 'for i in 1 2 3; do echo DSH_LIVE_$i; sleep 8; done';
    await rpc('prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text:
      `This is a live-console integration check. Use the read tool once on fixture.txt in the current workspace. Then call terminal_create exactly once with title "Live output demo" and command ${JSON.stringify(command)}. Leave the terminal open for the user to inspect. Do not close it or call any additional tools. Then give a short confirmation.` }] });
    console.log('Submitted isolated live-console verification task.');
    // Reload to include sessions created outside this client's local session store.
    await page.reload({ waitUntil: 'networkidle' });
    await subscribeList(sessionId, 'agents');
    await subscribeList(otherSessionId, 'otherAgents');
    const group = page.getByRole('treeitem').filter({ has: page.getByText(created.workspace.title, { exact: true }) }).first();
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click();
    await page.getByText(title, { exact: true }).first().click();
    await page.waitForSelector('[data-dsh-bottom-toggle]');
    await page.waitForFunction(() => window.__sidebarCheck.agents.list.length === 1, null, { timeout: 180000 });
    uuid = await page.evaluate(() => window.__sidebarCheck.agents.list[0].uuid);
    await attachTerminal(uuid, 'terminal');
    await page.getByText('Live output demo', { exact: true }).first().click();
    await outputContains('terminal', 'DSH_LIVE_1');
    assert.equal(await page.evaluate(() => window.__sidebarCheck.terminal.text.includes('DSH_LIVE_3')), false,
      'first line arrives while command still running');
    await page.waitForSelector('.xterm:visible');
    await outputContains('terminal', 'DSH_LIVE_3');
    assert.deepEqual(await page.evaluate(() => window.__sidebarCheck.otherAgents.list), [], 'other session has no agent terminals');
    const activity = await sidebar('changes.ops', { sessionId });
    assert.ok(activity.events.some(event => event.type === 'tool/call' && event.data.name === 'read'), 'file reads appear in session activity');
    console.log('Verified file activity, agent-created terminal, visible xterm, incremental output, and session isolation.');

    await page.evaluate(() => window.__sidebarCheck.terminal.ws.close());
    await attachTerminal(uuid, 'terminal');
    await outputContains('terminal', 'DSH_LIVE_1');
    await outputContains('terminal', 'DSH_LIVE_3');
    await input('printf "DSH_%s\\n" INPUT_OK\r');
    await outputContains('terminal', 'DSH_INPUT_OK');
    console.log('Verified reconnect replay and interactive input.');
    await input('printf "DSH_%s\\n" WAITING; sleep 30; printf "DSH_%s\\n" SHOULD_NOT_FINISH\r');
    await outputContains('terminal', 'DSH_WAITING');
    await input('\x03');
    await input('printf "DSH_%s\\n" INTERRUPT_OK\r');
    await outputContains('terminal', 'DSH_INTERRUPT_OK');
    assert.equal(await page.evaluate(() => window.__sidebarCheck.terminal.text.includes('DSH_SHOULD_NOT_FINISH')), false);
    console.log('Verified reconnect replay, interactive input, and interruption.');
    if (process.env.DSH_VERIFY_SCREENSHOT) await page.screenshot({ path: process.env.DSH_VERIFY_SCREENSHOT, animations: 'disabled', timeout: 5000 });
    await sidebar('agent-pty.close', { uuid });
    uuid = undefined;
    await page.waitForFunction(() => window.__sidebarCheck.agents.list.length === 0);
    assert.equal(errors.length, 0, 'no browser errors during terminal lifecycle');
    console.log('Verified terminal cleanup.');
  }
} catch (error) {
  if (process.env.DSH_VERIFY_SCREENSHOT) await page.screenshot({ path: process.env.DSH_VERIFY_SCREENSHOT, animations: 'disabled', timeout: 5000 }).catch(() => {});
  let detail = String(error?.stack ?? error);
  if (secret) detail = detail.split(secret).join('<redacted>');
  console.error(detail);
  process.exitCode = 1;
} finally {
  // Also clean up if navigation failed after the agent created its terminal.
  if (!uuid && sessionId) uuid = await page.evaluate(() => window.__sidebarCheck?.agents?.list?.[0]?.uuid).catch(() => undefined);
  if (uuid) await sidebar('agent-pty.close', { uuid }).catch(() => {});
  for (const id of [sessionId, otherSessionId].filter(Boolean)) {
    await rpc('cancel', { sessionId: id }).catch(() => {});
    await rpc('workspace/archiveSession', { sessionId: id }).catch(() => {});
  }
  if (workspaceId) await rpc('workspace/delete', { workspaceId }).catch(() => {});
  if (fixture) await rm(fixture, { recursive: true, force: true });
  await browser.close();
}
