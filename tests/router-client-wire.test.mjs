import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

// The wire check needs an installed runtime patched by this release. It is
// mandatory in the packaged CI runtime (DSH_TEST_HARNESS=1) and also runs at
// image build; host runs need DSH_RUNTIME_ROOT pointing at such a runtime.
const runtime = process.env.DSH_RUNTIME_ROOT ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh';
let adapter = '';
try { adapter = await readFile(`${runtime}/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`, 'utf8'); } catch {}
const patched = adapter.includes('dsh-router-contract-v3') && adapter.includes('dsh-resident-availability-v2');
if (!patched && process.env.DSH_TEST_HARNESS === '1') throw new Error('the packaged runtime lacks the router contract patches');

test('a queued request outlives the idle timeout on keepalives; every §10 code maps to its action', {
  skip: patched ? false : 'no runtime patched by this release; set DSH_RUNTIME_ROOT',
}, async () => {
  const { stdout } = await promisify(execFile)(process.execPath,
    [new URL('../scripts/verify-router-client-wire.mjs', import.meta.url).pathname, `${runtime}/node_modules`], { timeout: 120000 });
  assert.match(stdout, /queued 4x past the idle timeout completed on router keepalive comments/);
  assert.match(stdout, /classify by error\.code before HTTP status, inside and outside streams/);
});
