import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { upstreamFetch } from '../src/upstream.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server, timers) {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  if (!server.listening) return;
  const closed = new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  server.closeAllConnections?.();
  await closed;
}

function createFixture(handler) {
  const timers = new Set();
  const schedule = (callback, delay) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timers.add(timer);
    return timer;
  };
  const server = http.createServer((request, response) => handler(request, response, schedule));
  return { server, timers };
}

test('native upstream transport waits for delayed headers and frames JSON with Content-Length', async (t) => {
  let observed = null;
  const fixture = createFixture(async (request, response, schedule) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    observed = {
      body: Buffer.concat(chunks).toString('utf8'),
      contentLength: request.headers['content-length'],
      transferEncoding: request.headers['transfer-encoding']
    };
    schedule(() => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    }, 75);
  });
  t.after(() => close(fixture.server, fixture.timers));
  const port = await listen(fixture.server);
  const body = '{"prompt":"hello"}';

  const response = await upstreamFetch({
    upstreamUrl: `http://127.0.0.1:${port}`,
    upstreamTimeoutMs: 250
  }, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(observed, {
    body,
    contentLength: String(Buffer.byteLength(body)),
    transferEncoding: undefined
  });
});

test('native upstream transport aborts a delayed-header request at the configured timeout', async (t) => {
  const fixture = createFixture((_request, response, schedule) => {
    schedule(() => {
      if (response.destroyed) return;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    }, 500);
  });
  t.after(() => close(fixture.server, fixture.timers));
  const port = await listen(fixture.server);

  await assert.rejects(
    upstreamFetch({
      upstreamUrl: `http://127.0.0.1:${port}`,
      upstreamTimeoutMs: 30
    }, '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"prompt":"hello"}'
    }),
    (error) => {
      assert.equal(error.name, 'AbortError');
      assert.equal(error.code, 'ABORT_ERR');
      return true;
    }
  );
});
