import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

// The platform schema package is a runtime peer dependency; see the resolver.
register('./portal-wallpapers.resolve.mjs', import.meta.url);

// The receiving half of "send a wallpaper to the Harness": the host half reads
// the Service Portal's export queue over the same-origin routes the browser
// half is allowed to call, and the browser half writes what arrives into the
// dsh-ui-appearance plugin's own storage. Both halves are exercised against
// fakes — no portal, no browser.

const repo = new URL('../', import.meta.url);
const plugin = new URL('seed/profile/plugins/dsh-portal-wallpapers/', repo);
const hostModule = await import(new URL('index.js', plugin).href);

const ID = '3b24a1d8-6c4e-4a1b-9a77-2f1c0d5e8b34';
const OTHER = 'a1b2c3d4-0000-4000-8000-000000000002';

/* ------------------------------------------------------------------ *
 * Host half                                                          *
 * ------------------------------------------------------------------ */

function fakeHost({ portal, config = { portalBaseURL: '' } } = {}) {
  const routes = new Map();
  const calls = [];
  const ctx = {
    effect: (fn) => fn(),
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } } },
  };
  const original = globalThis.fetch;
  if (portal !== undefined) {
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      return portal(String(url), options);
    };
  }
  hostModule.apply(ctx, config);
  return {
    routes,
    calls,
    close: () => { globalThis.fetch = original; },
    call: async (path, { method = 'GET', headers = {}, ...rest } = {}) => {
      const route = routes.get(path.split('?')[0]);
      assert.ok(route, `route registered: ${path}`);
      assert.ok(route.methods.includes(method), `${method} allowed on ${path}`);
      const response = await route.fetch(new Request(`https://harness.test${path}`, { method, headers, ...rest }));
      const type = response.headers.get('content-type') || '';
      const body = type.includes('json') ? await response.json() : await response.arrayBuffer();
      return { status: response.status, body, headers: response.headers };
    },
  };
}

const FORWARDED = { 'x-forwarded-host': 'harness.test' };

const queueBody = (entries) => Response.json({ ok: true, queued: entries });
const entry = (id = ID, over = {}) => ({
  id, queuedAt: 1730000000000, slotId: 'slot-1', slotName: 'Ultrawide', slotNumber: 0, position: 2, slotCount: 4,
  type: 'image/png', imageDark: true, accent: '#b03b3b', ...over,
});

test('the host exposes the queue, the asset proxy and the ack, and nothing else', () => {
  const h = fakeHost({ portal: async () => queueBody([]) });
  assert.deepEqual([...h.routes.keys()].sort(), [
    '/api/portal-wallpapers/ack', '/api/portal-wallpapers/asset', '/api/portal-wallpapers/queue',
  ]);
  assert.deepEqual(h.routes.get('/api/portal-wallpapers/queue').methods, ['GET']);
  assert.deepEqual(h.routes.get('/api/portal-wallpapers/ack').methods, ['POST']);
  // The shared API channel requires a body mode on every route, GETs included;
  // one registered without it answers 400 before the handler runs.
  for (const [path, route] of h.routes) {
    assert.equal(route.requestBody, 'buffered', `${path} declares how its request body is presented`);
  }
  h.close();
});

test('the queue is the portal’s, answered with the origin it came from', async () => {
  const h = fakeHost({ portal: async (url) => {
    assert.equal(url, 'http://harness.test/api/appearance/export');
    return queueBody([entry()]);
  } });
  const result = await h.call('/api/portal-wallpapers/queue', { headers: FORWARDED });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, source: 'http://harness.test/', queued: [entry()] });
  h.close();
});

test('the portal address is config first, then the environment, then the served host', async () => {
  const resolved = (headers, configured = '') =>
    hostModule.resolvePortalBase({ headers: new Headers(headers) }, configured);
  assert.deepEqual(resolved({ host: 'harness.test:3443' }), { base: 'http://harness.test/', source: 'request-host' });
  assert.deepEqual(resolved({ host: 'harness.test:3443' }, 'https://portal.lan:8443/'),
    { base: 'https://portal.lan:8443/', source: 'config' });
  // Only the origin survives: a configured path or a non-http scheme cannot be
  // smuggled into the upstream request.
  assert.deepEqual(resolved({}, 'http://portal.lan/somewhere/else'), { base: 'http://portal.lan/', source: 'config' });
  assert.deepEqual(resolved({}, 'javascript:alert(1)//'), { source: 'config', error: 'scheme' });
  assert.deepEqual(resolved({}, 'not a url'), { source: 'config', error: 'malformed' });
  assert.equal(resolved({}), undefined, 'no host header and no config has no answer');

  process.env.PORTAL_BASE_URL = 'http://192.168.1.7/';
  try {
    assert.deepEqual(resolved({ host: 'harness.test:3443' }), { base: 'http://192.168.1.7/', source: 'config' });
  } finally {
    delete process.env.PORTAL_BASE_URL;
  }
});

test('a bad portal address is refused instead of being fetched anyway', async () => {
  let hits = 0;
  const broken = fakeHost({ portal: async () => { hits += 1; return queueBody([]); }, config: { portalBaseURL: 'ftp://nope' } });
  const bad = await broken.call('/api/portal-wallpapers/queue', { headers: FORWARDED });
  assert.equal(bad.status, 200, 'an unusable address is reported, not thrown at the browser');
  assert.equal(bad.body.code, 'bad-portal-url');
  assert.equal(hits, 0, 'the unusable address was never requested');
  broken.close();

  const unconfigured = fakeHost({ portal: async () => { hits += 1; return queueBody([]); } });
  const none = await unconfigured.call('/api/portal-wallpapers/queue');
  assert.equal(none.status, 200, 'no address and no forward header: say so rather than guess');
  assert.equal(none.body.code, 'unconfigured');
  assert.equal(hits, 0);
  unconfigured.close();
});

test('portal trouble is reported as codes the browser can explain', async () => {
  for (const [name, portal, code] of [
    ['no answer', async () => { throw Object.assign(new TypeError('fetch failed'), { cause: {} }); }, 'unreachable'],
    ['too slow', async () => { throw new DOMException('slow', 'TimeoutError'); }, 'timeout'],
    ['refused', async () => new Response('nope', { status: 404 }), 'upstream-status'],
    ['nonsense', async () => Response.json({ ok: false }), 'bad-upstream'],
  ]) {
    const h = fakeHost({ portal });
    const result = await h.call('/api/portal-wallpapers/queue', { headers: FORWARDED });
    // Polled from every open tab, so trouble travels in the body: a 5xx here
    // would show the browser a console error for an expected condition.
    assert.equal(result.status, 200, name);
    assert.equal(result.body.ok, false, name);
    assert.equal(result.body.code, code, name);
    h.close();
  }
});

test('an asset is proxied with the headers that describe its bytes', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const h = fakeHost({ portal: async (url) => {
    assert.match(url, new RegExp(`^http://harness\\.test/api/appearance/wallpapers/${ID}/thumbnail$`));
    return new Response(bytes, {
      headers: { 'content-type': 'image/webp', etag: '"abc"', 'cache-control': 'private, max-age=30' },
    });
  } });
  const result = await h.call(`/api/portal-wallpapers/asset?id=${ID}&kind=thumbnail`, { headers: FORWARDED });
  assert.equal(result.status, 200);
  assert.deepEqual([...new Uint8Array(result.body)], [1, 2, 3, 4]);
  assert.equal(result.headers.get('content-type'), 'image/webp');
  assert.equal(result.headers.get('etag'), '"abc"');
  assert.equal(result.headers.get('cache-control'), 'private, max-age=30');
  h.close();
});

test('an asset request that cannot be right never reaches the portal', async () => {
  let hits = 0;
  const h = fakeHost({ portal: async () => { hits += 1; return new Response('x'); } });
  for (const query of ['', '?id=..%2F..%2Fetc%2Fpasswd', `?id=${ID}&kind=video`]) {
    const result = await h.call(`/api/portal-wallpapers/asset${query}`, { headers: FORWARDED });
    assert.equal(result.status, 400, query || 'no query');
    h.close();
  }
  assert.equal(hits, 0, 'none of those reached the portal');
});

test('an oversized asset is cut off rather than streamed through', async () => {
  const declared = fakeHost({ portal: async () => new Response(null, { headers: { 'content-length': String(100 * 1024 * 1024) } }) });
  const byLength = await declared.call(`/api/portal-wallpapers/asset?id=${ID}&kind=image`, { headers: FORWARDED });
  // One file's trouble, so the status is allowed to say it.
  assert.equal(byLength.status, 413);
  assert.equal(byLength.body.code, 'too-large');
  declared.close();

  const lying = fakeHost({ portal: async () => new Response('x'.repeat(9 * 1024 * 1024), { headers: { 'content-type': 'image/png' } }) });
  const byBody = await lying.call(`/api/portal-wallpapers/asset?id=${ID}&kind=thumbnail`, { headers: FORWARDED });
  assert.equal(byBody.status, 413);
  assert.equal(byBody.body.code, 'too-large');
  lying.close();

  const gone = fakeHost({ portal: async () => new Response('gone', { status: 404 }) });
  assert.equal((await gone.call(`/api/portal-wallpapers/asset?id=${ID}`, { headers: FORWARDED })).status, 404);
  gone.close();
});

test('the ack is forwarded and the portal answers for itself', async () => {
  const h = fakeHost({ portal: async (url, options) => {
    assert.equal(url, 'http://harness.test/api/appearance/export/ack');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body).ids, [ID, OTHER]);
    return Response.json({ ok: true, removed: 2 });
  } });
  const result = await h.call('/api/portal-wallpapers/ack', {
    method: 'POST', headers: { 'content-type': 'application/json', ...FORWARDED }, body: JSON.stringify({ ids: [ID, OTHER] }),
  });
  assert.deepEqual(result.body, { ok: true, removed: 2, source: 'http://harness.test/' });
  h.close();

  for (const body of [{ ids: 'nope' }, { ids: ['not-a-uuid'] }, { ids: [] .concat(Array.from({ length: 51 }, () => ID)) }, {}]) {
    const strict = fakeHost({ portal: async () => assert.fail('must not reach the portal') });
    const refused = await strict.call('/api/portal-wallpapers/ack', {
      method: 'POST', headers: { 'content-type': 'application/json', ...FORWARDED }, body: JSON.stringify(body),
    });
    assert.equal(refused.status, 400, JSON.stringify(body).slice(0, 30));
    strict.close();
  }
});

/* ------------------------------------------------------------------ *
 * Browser half                                                       *
 * ------------------------------------------------------------------ */

/** A minimal browser: enough localStorage, IndexedDB, DOM and fetch to run the client. */
function fakeBrowser({ queued = [], portal = {}, prefs, appearance, rawAppearance } = {}) {
  const storage = new Map();
  const databases = new Map();
  const dispatched = [];
  const acks = [];
  const timers = [];
  /** Every object URL this browser minted, and whether it is still live. */
  const urls = new Map();
  let nextUrl = 0;
  /** The mounted instance whose hooks the fake React is answering, if any. */
  const hooks = { host: null };

  const db = (name) => {
    if (!databases.has(name)) databases.set(name, new Map());
    return databases.get(name);
  };

  /**
   * One IndexedDB request. The work is handed to the browser's realm, so its
   * continuation is a host microtask: `queueMicrotask` alone would let a
   * transaction's `oncomplete` overtake it, which is why this chain also goes
   * through `Promise.resolve()` — one tick slower, in the right order.
   */
  const deferred = (run) => {
    const box = {};
    Promise.resolve().then(() => {
      try {
        box.result = run();
        box.onsuccess?.();
      } catch (error) {
        box.onerror?.(error);
      }
    });
    return box;
  };

  const context = {
    console,
    Blob,
    Uint8Array,
    Math,
    Date,
    JSON,
    Number,
    String,
    Object,
    Array,
    Set,
    Map,
    Promise,
    Error,
    TypeError,
    RegExp,
    parseInt,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)); },
      removeItem: (key) => { storage.delete(key); },
    },
    indexedDB: {
      open(name) {
        const databases_ = db(name);
        // No upgrade machinery: a store exists as soon as anything asks for it.
        const storeOf = (store) => {
          if (!databases_.has(store)) databases_.set(store, new Map());
          return databases_.get(store);
        };
        return {
          result: {
            close: () => {},
            objectStoreNames: { contains: (store) => databases_.has(store) },
            createObjectStore: (store) => { storeOf(store); },
            transaction: (store) => ({
              objectStore: () => ({
                put: (value, key) => deferred(() => { storeOf(store).set(key ?? value.key, value); }),
                delete: (key) => deferred(() => { storeOf(store).delete(key); }),
                getAll: () => deferred(() => [...storeOf(store).values()]),
              }),
              set oncomplete(fn) { Promise.resolve().then(fn); },
              set onerror(_fn) {},
            }),
          },
          // Same reasoning as deferred(): the callback belongs to the browser's
          // realm, so deliver it through the host's promise jobs.
          set onsuccess(fn) { Promise.resolve().then(fn); },
          set onerror(_fn) {},
          set onupgradeneeded(fn) {},
        };
      },
    },
    document: {
      visibilityState: 'visible',
      getElementById: () => null,
      createElement: () => ({ set textContent(_v) {}, }),
      head: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    URL: {
      // Object URLs as a browser keeps them: live until something revokes them,
      // and an <img> still holding a revoked one draws a broken picture. Which
      // one is which is what the settings-row test below watches.
      createObjectURL: () => {
        nextUrl += 1;
        const url = `blob:fake-${nextUrl}`;
        urls.set(url, 'live');
        return url;
      },
      revokeObjectURL: (url) => { urls.set(url, 'revoked'); },
    },
    StorageEvent: class StorageEvent {
      constructor(type, init) { this.type = type; Object.assign(this, init); dispatched.push(init?.key); }
    },
    fetch: async (input, options) => {
      const url = String(input);
      if (url.startsWith('/api/portal-wallpapers/ack')) {
        acks.push(JSON.parse(options.body).ids);
        return Response.json({ ok: true, removed: 1 });
      }
      if (url.startsWith('/api/portal-wallpapers/queue')) return portal.queue ? portal.queue() : queueBody(queued);
      const asset = new URL(`https://harness.test${url}`).searchParams;
      const kind = asset.get('kind');
      if (portal[kind]) return portal[kind](asset.get('id'));
      return new Response(`bytes-of-${kind}`, { headers: { 'content-type': kind === 'image' ? 'image/png' : 'image/webp' } });
    },
    __ModuleLoader__: {
      loaded: new Map(),
      load(module) { this.loaded.set(module.id, module.factory); },
    },
  };
  // What was already in the browser before this pass: the client's own
  // preferences, and whatever the Appearance plugin had left in its storage.
  if (prefs !== undefined) context.localStorage.setItem('dsh-portal-wallpapers.settings', JSON.stringify(prefs));
  if (appearance !== undefined) context.localStorage.setItem('dsh-ui-appearance.settings', JSON.stringify(appearance));
  if (rawAppearance !== undefined) context.localStorage.setItem('dsh-ui-appearance.settings', rawAppearance);
  context.window = context;
  context.globalThis = context;

  runInNewContext(readFileSync(new URL('client.js', plugin), 'utf8'), context, { filename: 'client.js' });
  const factory = context.__ModuleLoader__.loaded.get('dsh-portal-wallpapers');
  assert.ok(factory, 'the client registers itself with the module loader');

  const stores = new Map();
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    // Answered by whichever instance mount() is rendering; see mount().
    useState: (initial) => hooks.host.useState(initial),
    useEffect: (effect, deps) => hooks.host.useEffect(effect, deps),
  };
  /** Everything the client registered with the platform, as it registered it. */
  const strings = {};
  const namespaces = [];
  const api = {
    context,
    storage,
    dispatched,
    acks,
    timers,
    databases,
    appearanceSettings: () => JSON.parse(storage.get('dsh-ui-appearance.settings') ?? 'null'),
    rawAppearanceSettings: () => storage.get('dsh-ui-appearance.settings') ?? null,
    appearanceImages: () => [...(db('dsh-ui-appearance').get('images') ?? new Map()).values()],
    library: () => [...(db('dsh-portal-wallpapers').get('images') ?? new Map()).values()],
    rows: new Map(),
    urls,
    hooks,
    localeStrings: strings,
    localeNamespaces: () => namespaces,
  };

  const snapshotStore = (initial) => {
    const listeners = new Set();
    const store = {
      getSnapshot: () => initial,
      update: (mutate) => { mutate(initial); for (const listener of listeners) listener(initial); },
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    };
    stores.set(initial, store);
    return store;
  };

  const ctx = {
    effect: (fn) => fn(),
    locale: {
      register: (namespace, translations) => {
        namespaces.push(namespace);
        Object.assign(strings, translations);
      },
    },
    slots: {
      inject: (name, register) => { const row = register(); api.rows.set(row.id, row); },
      register: (meta, component) => ({ ...meta, component }),
    },
  };
  const modules = {
    react,
    '@deepseek-ai/dsh-client-ui-primitives': { Switch: () => null },
    '@deepseek-ai/dsh-client-store': { createSnapshotStore: snapshotStore },
  };
  factory((name) => {
    assert.ok(name in modules, `the client requires a known platform module: ${name}`);
    return modules[name];
  }).apply(ctx);

  const poll = new Promise((resolve) => { api.resolvePoll = resolve; });
  return api;
}

/**
 * Let the client's pass run: its own timers are inert in the fake, so this
 * simply yields until its promise chain has had every turn it wants.
 */
const settle = async () => {
  for (let i = 0; i < 40; i += 1) await new Promise((resolve) => { setTimeout(resolve, 0); });
};

/** Wait for an outcome, then assert it — a hung pass should say so. */
const waitFor = async (predicate, description) => {
  for (let i = 0; i < 80 && predicate() !== true; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
  assert.equal(predicate(), true, description);
};

const rowMeta = (browser) => browser.rows.get('portal-wallpapers');

/**
 * Render one component the way the settings panel does, with just enough React
 * to be the thing that matters here: hooks keep their state while the instance
 * is mounted, effects run after the render that scheduled them, a `setState`
 * re-renders, and `unmount()` runs every cleanup — which is exactly what closing
 * Settings is. Function children are rendered too, so a preview is reachable as
 * the component that owns its object URL.
 */
function mount(component, props, browser) {
  const nodes = new Map();
  const pending = [];
  let path = 'row';
  let dirty = false;

  const outer = browser.hooks.host;
  browser.hooks.host = {
    useState(initial) {
      const node = nodes.get(path);
      const index = node.cursor++;
      if (node.state.length <= index) node.state.push(typeof initial === 'function' ? initial() : initial);
      const value = node.state[index];
      return [value, (next) => {
        node.state[index] = typeof next === 'function' ? next(node.state[index]) : next;
        dirty = true;
      }];
    },
    useEffect(effect, deps) {
      const node = nodes.get(path);
      const index = node.cursor++;
      const seen = node.effects.get(index);
      const same = seen !== undefined && deps !== undefined && seen.deps !== undefined
        && seen.deps.length === deps.length && seen.deps.every((dep, at) => dep === deps[at]);
      if (same === true) return;
      // A re-run also retires what the previous run scheduled, so a deps list
      // that changes cannot leave an effect's cleanup stranded.
      seen?.cleanup?.();
      pending.push(() => node.effects.set(index, { deps, cleanup: effect() }));
    },
  };

  const renderNode = (element, key) => {
    if (element === null || element === undefined || typeof element !== 'object') return element;
    if (Array.isArray(element)) return element.map((child, at) => renderNode(child, `${key}/${at}`));
    if (typeof element.type !== 'function') {
      return { ...element, children: (element.children ?? []).map((child, at) => renderNode(child, `${key}/${at}`)) };
    }
    if (!nodes.has(key)) nodes.set(key, { state: [], effects: new Map(), cursor: 0 });
    const node = nodes.get(key);
    const above = path;
    path = key;
    // Hook slots are addressed per render, exactly as React counts them: without
    // this reset a second render would ask for the next slot and lose its state.
    node.cursor = 0;
    let tree = element.type(element.props);
    for (let pass = 0; dirty === true && pass < 8; pass += 1) {
      dirty = false;
      tree = element.type(element.props);
    }
    path = above;
    return renderNode(tree, `${key}!`);
  };

  let tree;
  for (let pass = 0; pass < 8; pass += 1) {
    dirty = false;
    tree = renderNode({ type: component, props, children: [] }, 'row');
    while (pending.length > 0) {
      // Splice, not a copy plus a reset: `pending.length = 0` would empty the
      // very array the jobs were taken from and run none of them.
      for (const job of pending.splice(0)) job();
    }
    if (dirty === false) break;
  }
  browser.hooks.host = outer;

  return {
    tree,
    unmount() {
      for (const node of nodes.values()) {
        for (const effect of [...node.effects.values()].reverse()) effect.cleanup?.();
        node.effects.clear();
      }
    },
  };
}

/** Every element of a rendered tree that matches, depth first. */
const findAll = (node, matches, found = []) => {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, matches, found);
  } else if (node !== null && typeof node === 'object') {
    if (matches(node)) found.push(node);
    for (const child of node.children ?? []) findAll(child, matches, found);
  }
  return found;
};

const pictures = (tree) => findAll(tree, (node) => node.type === 'img').map((node) => node.props);

/** The props the platform hands the settings row, from what it injected. */
const rowProps = (browser) => {
  const row = rowMeta(browser);
  const injected = row.inject();
  return {
    useState: (select) => select(injected.hooks.state.getSnapshot()),
    usePrefs: (select) => select(injected.hooks.prefs.getSnapshot()),
    setPref: injected.setPref,
    check: injected.check,
    show: injected.show,
    t: (key) => browser.localeStrings[key] ?? key,
  };
};

test('a received wallpaper shows in the strip, and keeps showing next visit', async () => {
  const browser = fakeBrowser({ queued: [entry()] });
  await waitFor(() => browser.acks.length > 0, 'the wallpaper was received');
  await settle();

  const row = rowMeta(browser);
  const props = rowProps(browser);
  assert.equal(row.inject().hooks.state.getSnapshot().records.length, 1, 'one wallpaper in the switcher');

  // One visit to Settings: the preview is drawn, from an object URL that works.
  const visit = mount(row.component, props, browser);
  const [first] = pictures(visit.tree);
  assert.ok(first !== undefined && String(first.src).startsWith('blob:'), 'the preview is drawn as a picture');
  assert.equal(browser.urls.get(first.src), 'live', 'the address behind the preview is live');

  // Closing Settings takes the row away, and with it the picture it was showing.
  visit.unmount();
  assert.equal(browser.urls.get(first.src), 'revoked', 'the visit released its picture on the way out');

  // The next visit sees the same stored wallpaper. It has to be drawn again,
  // which it can only be from a fresh address: the one above is gone, and an
  // <img> still holding it is the broken thumbnail this guards.
  const again = mount(row.component, props, browser);
  const [second] = pictures(again.tree);
  assert.ok(second !== undefined, 'the wallpaper is still offered on the next visit');
  assert.notEqual(second.src, first.src, 'a new visit does not reuse the released address');
  assert.equal(browser.urls.get(second.src), 'live', 'and the picture shows');
});

test('the client adds one settings row beneath the Appearance row', () => {
  const browser = fakeBrowser();
  const row = rowMeta(browser);
  assert.equal(row.name, 'settings.general.item');
  // Directly after dsh-ui-appearance's own row (1000): the two describe one result.
  assert.equal(row.order, 1001);
  assert.equal(typeof row.component, 'function');
  const injected = row.inject();
  assert.deepEqual(Object.keys(injected).sort(), ['check', 'hooks', 'setPref', 'show']);
  assert.deepEqual(Object.keys(injected.hooks).sort(), ['prefs', 'state']);
});

test('a queued wallpaper becomes the background and leaves the queue on ack', async () => {
  const browser = fakeBrowser({ queued: [entry()] });
  await waitFor(() => browser.acks.length > 0, 'the wallpaper was received and acked');
  await settle();

  const settings = browser.appearanceSettings();
  assert.ok(settings, 'the appearance settings section was written');
  assert.equal(settings.imageDark, true, 'darkness always travels with the wallpaper for text contrast');
  assert.equal(settings.accent, undefined, 'the accent is not touched unless adoption is on');

  const imageStore = browser.databases.get('dsh-ui-appearance').get('images') ?? new Map();
  assert.equal(imageStore.size, 1, 'exactly one image record was added to the Appearance store');
  const [record] = imageStore.values();
  assert.equal([...imageStore.keys()][0], settings.backgroundImage, 'the settings point at that record');
  assert.equal(await record.data.text(), 'bytes-of-image', 'the full-size picture, not the preview');
  assert.equal(record.name, 'Ultrawide 3', 'named by slot and position, like the portal names it');
  assert.deepEqual([...browser.acks.flat()], [ID], 'the queue entry was acked once imported');
  assert.deepEqual(browser.dispatched, ['dsh-ui-appearance.settings'], 'the appearance plugin is woken by its own storage event');

  const saved = browser.library();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, ID);
  assert.equal(saved[0].appearanceKey, settings.backgroundImage, 'what it stored is what is showing');
});

test('adopting the wallpaper’s colors follows the Appearance plugin’s own rules', async () => {
  // The user chose a panel color themselves; the accent family fills only what
  // is unset, in the mode the wallpaper's darkness points at.
  const browser = fakeBrowser({
    queued: [entry()],
    prefs: { enabled: true, adoptAccent: true },
    appearance: { accent: '#000000', light: {}, dark: { panel: '#123456' } },
  });
  await waitFor(() => browser.acks.length > 0, 'the wallpaper arrived');
  await settle();
  const settings = browser.appearanceSettings();
  assert.equal(settings.accent, '#b03b3b');
  assert.equal(settings.dark.accent, '#b03b3b');
  assert.equal(settings.dark.panel, '#123456', 'a color the user picked for this mode survives');
  assert.match(settings.dark.background, /^#[0-9a-f]{6}$/);
  assert.equal(settings.dark.preset, 'custom');
  assert.equal(settings.preset, 'custom');
});

test('a wallpaper already received is not stored twice, but a re-send puts it back', async () => {
  const first = fakeBrowser({ queued: [entry()] });
  await waitFor(() => first.acks.length > 0, 'the first wallpaper arrived');
  await settle();
  const before = first.appearanceSettings().backgroundImage;

  // Same wallpaper, sent again later: a newer queue entry, so the browser takes
  // it again — one stored wallpaper per send, and it is showing once more.
  const again = fakeBrowser({ queued: [entry(ID, { queuedAt: 1730000999000 })] });
  await waitFor(() => again.acks.length > 0, 'the re-send arrived');
  await settle();
  assert.equal(again.library().length, 1, 'not a second copy');
  assert.notEqual(again.appearanceSettings().backgroundImage, before, 'and it is on screen again');
});

test('unreadable Appearance settings keep the picture and say why it is not showing', async () => {
  const browser = fakeBrowser({ queued: [entry()], rawAppearance: '{ broken' });
  await waitFor(() => browser.library().length > 0, 'the wallpaper reached the switcher even though it could not be shown');
  await settle();
  assert.equal(browser.rawAppearanceSettings(), '{ broken', 'the unreadable value was never overwritten');
  assert.equal(browser.appearanceImages().length, 0, 'and no image was left behind in the Appearance store');
  const saved = browser.library();
  assert.equal(saved[0].appearanceKey, '', 'stored, waiting for a click once Appearance is readable again');
  // The queue hands over the file, not the result: it arrived, so it is acked
  // even though it could not be put on screen.
  assert.deepEqual([...browser.acks.flat()], [ID], 'acked once stored, so it is not fetched again');
});

test('the client agrees with the host about every route it calls', () => {
  const source = readFileSync(new URL('client.js', plugin), 'utf8');
  assert.match(source, new RegExp(`const QUEUE_ROUTE = '${hostModule.QUEUE_ROUTE}'`));
  assert.match(source, new RegExp(`const ASSET_ROUTE = '${hostModule.ASSET_ROUTE}'`));
  assert.match(source, new RegExp(`const ACK_ROUTE = '${hostModule.ACK_ROUTE}'`));
  // The appearance plugin's real storage identifiers, not a guess.
  assert.match(source, /const APPEARANCE_DB = 'dsh-ui-appearance'/);
  assert.match(source, /const APPEARANCE_DB_VERSION = 2/);
  assert.match(source, /const APPEARANCE_IMAGE_STORE = 'images'/);
  assert.match(source, /const APPEARANCE_SETTINGS_KEY = 'dsh-ui-appearance\.settings'/);
  // Both halves must describe the same bounded storage.
  assert.match(source, /const MAX_ITEMS = (\d+)/);
  assert.match(source, /const MAX_TOTAL_BYTES = (\d+ \* 1024 \* 1024)/);
  const readme = readFileSync(new URL('README.md', plugin), 'utf8');
  for (const marker of ['12 most recent', '150 MB', '7 days', '64 MB image']) {
    assert.ok(readme.includes(marker), `README documents its bound: ${marker}`);
  }
});

test('every message the browser half can show is translated', () => {
  const browser = fakeBrowser();
  assert.deepEqual(browser.localeNamespaces(), ['settings.portalWallpapers']);
  const { en, zh } = browser.localeStrings;
  const missing = Object.keys(en).filter((key) => !(key in zh));
  assert.deepEqual(missing, [], 'a string with no Chinese answer');
  const extra = Object.keys(zh).filter((key) => !(key in en));
  assert.deepEqual(extra, [], 'a Chinese string that is never shown');
  // Error codes reach the user through `err<Code>` names: an error string the
  // browser half cannot name would be shown as a raw code.
  for (const key of [
    'errUnconfigured', 'errBadPortalUrl', 'errUnreachable', 'errTimeout', 'errUpstreamStatus',
    'errBadUpstream', 'errBadRequest', 'errNetwork', 'errNotFound', 'errStorageLibrary',
    'errStorageAppearance', 'errUnknown',
  ]) {
    assert.ok(key in en, `no English message for ${key}`);
    assert.ok(key in zh, `no Chinese message for ${key}`);
  }
  for (const [key, value] of Object.entries(en)) {
    assert.ok(value.length > 0, `${key} has no English text`);
  }
});

test('the plugin ships both halves and is wired into the profile', () => {
  const manifest = JSON.parse(readFileSync(new URL('package.json', plugin), 'utf8'));
  assert.equal(manifest.name, 'dsh-portal-wallpapers');
  assert.deepEqual(manifest.dsh.client, { platform: 'web', inject: [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-settings',
  ] });
  const profile = JSON.parse(readFileSync(new URL('seed/profile/package.json', repo), 'utf8'));
  assert.equal(profile.dependencies['dsh-portal-wallpapers'], 'link:./plugins/dsh-portal-wallpapers');
  const patch = readFileSync(new URL('seed/profile/managed/cordis.patch.yml', repo), 'utf8');
  assert.match(patch, /- id: portal-wallpapers\n\s+name: 'dsh-portal-wallpapers'/);
  const lock = JSON.parse(readFileSync(new URL('config/plugins.lock.json', repo), 'utf8'));
  assert.match(lock.plugins['dsh-portal-wallpapers'], /^0\.1\.0/);
  for (const script of ['scripts/check.sh', 'scripts/verify.sh']) {
    assert.match(readFileSync(new URL(script, repo), 'utf8'), /'dsh-portal-wallpapers@link:'/);
  }
});
