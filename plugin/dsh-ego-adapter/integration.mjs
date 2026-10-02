import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { startBrowserProxy } from './network.mjs';

const calls = new AsyncLocalStorage();
let proxy;
const selectedSpaces = new Map();
export const browserRoot = () => resolve(process.env.DSH_HOME || '/data/dsh', 'ego-browser');
export function conversationSpace(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('Browser tools require a Harness conversation');
  return 'dsh-' + createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}
export const currentSpace = () => { const base = calls.getStore(); return base ? selectedSpaces.get(base) || base : undefined; };

export function browserEnvironment(base = process.env) {
  const root = browserRoot();
  return { ...base, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'), EGO_LINUX_STATE_DIR: join(root, 'state/ego-lite-linux'),
    EGO_LINUX_PROFILE: join(root, 'profile'), EGO_LINUX_HEADLESS: '1', EGO_ISOLATE_SPACES: '0',
    ...(proxy ? { EGO_LINUX_PROXY: proxy.url } : {}) };
}

export async function prepareBrowser(ctx) {
  for (const dir of ['home', 'tmp', 'data', 'state/ego-lite-linux', 'config', 'cache', 'profile', 'screenshots']) {
    await mkdir(join(browserRoot(), dir), { recursive: true, mode: 0o700 });
  }
  proxy = await startBrowserProxy({ allowPrivate: (process.env.DSH_BROWSER_ALLOW_PRIVATE_HOSTS || 'false').toLowerCase() === 'true' });
  ctx.effect(() => async () => {
    await closeBrowser();
    await proxy?.close(); proxy = undefined;
  });
}

export async function closeBrowser() {
  try {
    const state = JSON.parse(await readFile(join(browserEnvironment().EGO_LINUX_STATE_DIR, 'browser.json'), 'utf8'));
    if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535) return;
    const response = await fetch(`http://127.0.0.1:${state.port}/json/version`, { signal: AbortSignal.timeout(2000) });
    const { webSocketDebuggerUrl } = await response.json();
    const address = new URL(webSocketDebuggerUrl);
    if (!['127.0.0.1', 'localhost'].includes(address.hostname)) return;
    await new Promise(resolveClose => {
      const socket = new WebSocket(address);
      const timer = setTimeout(() => { socket.close(); resolveClose(); }, 5000);
      const done = () => { clearTimeout(timer); resolveClose(); };
      socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Browser.close' })));
      socket.addEventListener('close', done, { once: true }); socket.addEventListener('error', done, { once: true });
    });
  } catch { /* No browser has been started, or it already exited. */ }
}

export function wrapTool(ctx, tool) {
  // Raw Node/CDP scripts bypass conversation selection and the browser network
  // proxy. Structured tools cover the supported container workflow. Desktop
  // cookie import is unavailable for this headless profile.
  if (['ego_login_import', 'ego_cli', 'ego_script'].includes(tool.name)) return null;
  const screenshot = tool.name === 'ego_screenshot';
  return { ...tool,
    description: (tool.name === 'ego_space_open' ? 'Open a browser workspace within the calling conversation. Use default for its main workspace. Website logins are shared across conversations.' : tool.description) + (screenshot ? ' The captured pixels are also attached directly for visual analysis.' : ''),
    execute: (args, exec) => calls.run(conversationSpace(exec?.agent?.session?.id), async () => {
      exec.signal?.throwIfAborted();
      const base = calls.getStore();
      const scoped = value => !value || value === 'default' || value === 'dsh-agent' ? base
        : value === base || value.startsWith(base + '-') ? value
        : base + '-' + createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
      args = { ...args };
      if (args.space !== undefined) args.space = scoped(String(args.space));
      if (tool.name === 'ego_space_open' || tool.name === 'ego_space_close') args.name = scoped(String(args.name || 'default'));
      if (tool.name === 'ego_http' && args.mode === 'server') throw new Error('Use browser-mode HTTP to preserve the deployment browsing policy.');
      const input = screenshot && !args.path
        ? { ...args, path: join(browserRoot(), 'screenshots', `${createHash('sha256').update(String(exec.callId)).digest('hex')}.png`) }
        : args;
      const value = await tool.execute(input, exec);
      exec.signal?.throwIfAborted();
      if (value?.ok !== false) {
        if (tool.name === 'ego_space_open') selectedSpaces.set(base, args.name);
        else if (tool.name === 'ego_space_close' && currentSpace() === args.name) selectedSpaces.delete(base);
        else if (args.space) selectedSpaces.set(base, args.space);
      }
      if (!screenshot || !value?.ok) return value;
      if (typeof value.path !== 'string' || (await stat(value.path)).size > 20 * 1024 * 1024) {
        throw new Error('Browser screenshot is missing or exceeds the image limit');
      }
      const image = await ctx.attachments.saveImage({ data: await readFile(value.path), mediaType: 'image/png', name: basename(value.path) });
      return { ...value, image };
    }),
    output: screenshot ? { ...tool.output,
      render: (args, value) => [...tool.output.render(args, value), ...(value.image ? [{ type: 'image', attachment: value.image }] : [])],
    } : tool.output,
  };
}

export async function scopeSpaces(req, data) {
  const id = new URL(req.url, 'http://localhost').searchParams.get('sessionId');
  if (!id) return { ...data, spaces: [] };
  let state;
  try { state = JSON.parse(await readFile(join(browserEnvironment().EGO_LINUX_STATE_DIR, 'task-spaces.json'), 'utf8')); }
  catch { return { ...data, spaces: [] }; }
  const name = conversationSpace(id);
  const targets = new Set((state.spaces || []).filter(space => space.name === name || space.name?.startsWith(name + '-')).flatMap(space => space.targetIds || []));
  return { ...data, spaces: (data.spaces || []).filter(page => targets.has(page.targetId)) };
}
