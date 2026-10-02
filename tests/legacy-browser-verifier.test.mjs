import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const exec = promisify(execFile);
const entry = new URL('../scripts/verify-dsh-playwright-stream.mjs', import.meta.url);

for (const allowUnauthenticated of [false, true]) {
  test(`legacy browser verifier ${allowUnauthenticated ? 'rejects broken' : 'accepts protected'} ego routes`, async () => {
    const paths = new Set();
    const server = createServer((req, res) => {
      const path = new URL(req.url, 'http://fixture.invalid').pathname;
      paths.add(path);
      if (path === '/') {
        res.writeHead(303, { 'set-cookie': 'dsh-auth-fixture=valid', location: '/' });
        return res.end();
      }
      if (!allowUnauthenticated && (req.headers.cookie !== 'dsh-auth-fixture=valid' || req.headers.origin)) {
        res.writeHead(403);
        return res.end();
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(path === '/api/ego/spaces' ? { spaces: [] } : { ok: true }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const result = exec(process.execPath, [fileURLToPath(entry)], { timeout: 10000, env: {
        ...process.env, DSH_BOOT_TOKEN: 'synthetic-launch-token',
        DSH_VERIFY_URL: `http://127.0.0.1:${server.address().port}`,
      } });
      if (allowUnauthenticated) {
        await assert.rejects(result, error => error.code === 1 && error.stderr.includes('rejected unauthorized'));
      } else {
        assert.match((await result).stdout, /Verified authenticated ego/);
        assert.deepEqual([...paths].sort(), ['/', '/api/ego/input', '/api/ego/spaces', '/api/ego/stream', '/ego/api/get', '/ego/api/set']);
      }
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
