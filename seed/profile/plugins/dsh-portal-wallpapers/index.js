// dsh-portal-wallpapers: host half.
//
// Reads the Service Portal's wallpaper export queue on behalf of the browser
// half and hands it the bytes. The browser cannot do this itself: the Harness
// page is served over https://host:3443 while the portal is plain http://host,
// and mixed content blocks that request outright — so every portal call goes
// through these same-origin routes.
//
//   GET  /api/portal-wallpapers/queue          the portal's pending sends
//   GET  /api/portal-wallpapers/asset?id=&kind=  thumbnail | image bytes
//   POST /api/portal-wallpapers/ack            report what was imported
//
// The queue itself lives in the portal (see its /api/appearance/export); this
// plugin only reads it, so a Harness that is switched off loses nothing more
// than the sends that expired while it was away.
//
// The queue and the ack answer 200 even when the portal did not answer, with
// the reason in the body. They are polled from every open tab of every
// deployment, where a portal being down is expected and recoverable — and a
// 5xx there would be logged by the browser as a page error, turning an
// ordinary Tuesday into a console full of red. The asset route keeps real
// statuses, because there the status is a fact about one file.
import z from '@deepseek-ai/schemastery';

export const name = 'portal-wallpapers';
export const inject = ['connection'];

export const QUEUE_ROUTE = '/api/portal-wallpapers/queue';
export const ASSET_ROUTE = '/api/portal-wallpapers/asset';
export const ACK_ROUTE = '/api/portal-wallpapers/ack';

/** Wallpaper ids are v4 UUIDs; anything else never reaches the portal. */
export const WALLPAPER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Portal paths behind each route. */
const PORTAL_QUEUE = '/api/appearance/export';
const PORTAL_ACK = '/api/appearance/export/ack';
const PORTAL_WALLPAPER = '/api/appearance/wallpapers/';

/** A queue read is a small JSON call; an image is a full-size picture. */
const QUEUE_TIMEOUT_MS = 10000;
const ASSET_TIMEOUT_MS = 60000;
/** Refuse absurd payloads rather than filling the browser with them. */
const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_ACK_IDS = 50;

export const Config = z.object({
  portalBaseURL: z.string().default('').description(
    'Base URL of the Service Portal that owns the wallpaper queue, e.g. http://192.168.1.7/ . '
    + 'Empty (default) uses the $PORTAL_BASE_URL environment variable, then the host this '
    + 'Harness was served from on plain http — which is the usual home-LAN layout.',
  ),
});

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

/**
 * Where the portal lives: explicit config, then the deployment environment,
 * then the address this Harness itself was reached on. The last step is the
 * one that makes the feature work with no configuration at all — the portal
 * and the Harness run on one host — and it is only ever a plain-http origin
 * derived by URL parsing, never a value interpolated into a URL.
 * @returns {{ base: string, source: string }} or undefined when unusable.
 */
export function resolvePortalBase(request, configured) {
  const explicit = (configured || process.env.PORTAL_BASE_URL || '').trim();
  if (explicit !== '') return normalizeBase(explicit, 'config', false);
  const authority = (request.headers.get('x-forwarded-host') || request.headers.get('host') || '').trim();
  if (authority === '') return undefined;
  // The port this Harness is served on belongs to the Harness; the portal is
  // reached on its own default port.
  return normalizeBase(`http://${authority}/`, 'request-host', true);
}

/**
 * Canonical "scheme://host[:port]/", http(s) only, with any path dropped: a
 * configured path cannot be smuggled into the fixed portal endpoints.
 * @param dropPort - discard the port (a derived address carries the Harness's
 *   own), keeping one only when it was written down explicitly.
 */
function normalizeBase(value, source, dropPort) {
  let url;
  try {
    url = new URL(value);
  } catch (_malformed) {
    return { source, error: 'malformed' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { source, error: 'scheme' };
  if (url.hostname === '') return { source, error: 'host' };
  if (dropPort === true) url.port = '';
  return { base: `${url.origin}/`, source };
}

/** Every upstream failure the browser can be told about, as a stable code. */
function failure(error) {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return { code: 'timeout', status: 504 };
  return { code: 'unreachable', status: 502 };
}

/** One portal call with a deadline: a slow portal must not hold the route. */
async function portalRequest(base, path, { timeoutMs, accept, init = {} }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
  try {
    return await fetch(base + path.slice(1), {
      ...init,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        ...(accept === undefined ? {} : { accept }),
        ...(init.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Read a proxied body with a hard cap: `{ bytes, size }`, or `{ overflow }`. */
async function readCapped(body, cap) {
  const reader = body?.getReader?.();
  if (reader === undefined) return { overflow: true };
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      return { overflow: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, size };
}

/** Forward just the headers that describe the bytes themselves. */
function passthroughHeaders(upstream, size) {
  const headers = new Headers();
  for (const name of ['content-type', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set('content-length', String(size));
  headers.set('cache-control', upstream.headers.get('cache-control') || 'private, max-age=600');
  return headers;
}

export function apply(ctx, config) {
  // Every route starts from the same question, and answers it the same way
  // when there is no usable answer: refuse, rather than guess twice.
  const resolve = (request) => resolvePortalBase(request, config?.portalBaseURL) ?? { error: 'unconfigured' };

  const refused = (resolved) => resolved.error === 'unconfigured'
    ? json({ ok: false, code: 'unconfigured' })
    : json({ ok: false, code: 'bad-portal-url', error: resolved.error });

  async function queue(request) {
    const target = resolve(request);
    if (target.error !== undefined) return refused(target);
    let upstream;
    try {
      upstream = await portalRequest(target.base, PORTAL_QUEUE, { timeoutMs: QUEUE_TIMEOUT_MS, accept: 'application/json' });
    } catch (error) {
      return json({ ok: false, code: failure(error).code, source: target.base });
    }
    if (!upstream.ok) return json({ ok: false, code: 'upstream-status', status: upstream.status, source: target.base });
    const body = await upstream.json().catch(() => null);
    if (body === null || body.ok !== true || Array.isArray(body.queued) !== true) {
      return json({ ok: false, code: 'bad-upstream', source: target.base });
    }
    return json({ ok: true, source: target.base, queued: body.queued });
  }

  async function asset(request) {
    const target = resolve(request);
    if (target.error !== undefined) return refused(target);
    const query = new URL(request.url).searchParams;
    const id = String(query.get('id') || '');
    const kind = String(query.get('kind') || 'thumbnail');
    if (WALLPAPER_ID.test(id) !== true) return json({ ok: false, code: 'bad-id' }, 400);
    if (kind !== 'thumbnail' && kind !== 'image') return json({ ok: false, code: 'bad-kind' }, 400);
    const cap = kind === 'image' ? MAX_IMAGE_BYTES : MAX_THUMBNAIL_BYTES;
    const path = PORTAL_WALLPAPER + encodeURIComponent(id) + (kind === 'image' ? '' : '/thumbnail');
    let upstream;
    try {
      upstream = await portalRequest(target.base, path, { timeoutMs: ASSET_TIMEOUT_MS, accept: 'image/*' });
    } catch (error) {
      return json({ ok: false, code: failure(error).code, source: target.base }, failure(error).status);
    }
    if (upstream.status === 404) return json({ ok: false, code: 'not-found', source: target.base }, 404);
    if (!upstream.ok) return json({ ok: false, code: 'upstream-status', status: upstream.status, source: target.base }, 502);
    const declared = Number(upstream.headers.get('content-length') || '0');
    if (declared > cap) return json({ ok: false, code: 'too-large', size: declared, source: target.base }, 413);
    const payload = await readCapped(upstream.body, cap);
    if (payload.overflow === true) return json({ ok: false, code: 'too-large', source: target.base }, 413);
    // The length this response actually carries, not the one upstream claimed.
    return new Response(payload.bytes, { status: 200, headers: passthroughHeaders(upstream, payload.size) });
  }

  async function ack(request) {
    const target = resolve(request);
    if (target.error !== undefined) return refused(target);
    let body;
    try {
      body = await request.json();
    } catch (_malformed) {
      return json({ ok: false, code: 'bad-request' }, 400);
    }
    const ids = Array.isArray(body?.ids) ? body.ids : null;
    if (ids === null || ids.length > MAX_ACK_IDS || ids.some((id) => typeof id !== 'string' || WALLPAPER_ID.test(id) !== true)) {
      return json({ ok: false, code: 'bad-request' }, 400);
    }
    let upstream;
    try {
      upstream = await portalRequest(target.base, PORTAL_ACK, {
        timeoutMs: QUEUE_TIMEOUT_MS,
        init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) },
      });
    } catch (error) {
      return json({ ok: false, code: failure(error).code, source: target.base });
    }
    const result = await upstream.json().catch(() => null);
    if (upstream.ok !== true || result === null) {
      return json({ ok: false, code: 'upstream-status', status: upstream.status, source: target.base });
    }
    return json({ ok: true, removed: result.removed, source: target.base });
  }

  // `requestBody` is required by the shared-channel contract, on a GET too: it
  // says how the bridge presents the request body, and a route registered
  // without it answers every call with 400 before the handler is reached.
  const route = (path, methods, fetch) => ctx.effect(
    () => ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch }),
    `portal-wallpapers: ${path}`,
  );

  route(QUEUE_ROUTE, ['GET'], queue);
  route(ASSET_ROUTE, ['GET'], asset);
  route(ACK_ROUTE, ['POST'], ack);
}
