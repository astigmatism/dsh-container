/** Wait for the real one-minute fixture idle policy to release Chromium. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const root = resolve(process.env.DSH_PROFILE_ROOT, '../../ego-browser/state/ego-lite-linux');
const browser = JSON.parse(await readFile(root + '/browser.json'));
const started = Date.now();
while (true) {
  let running = false;
  try { running = (await fetch(`http://127.0.0.1:${browser.port}/json/version`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
  if (!running) break;
  assert.ok(Date.now() - started < 140000, 'idle reaper releases Chromium within its interval and grace period');
  await delay(1000);
}
let status = '';
try { status = await readFile(`/proc/${browser.pid}/status`, 'utf8'); } catch {}
assert.ok(!status || /State:\s+Z/.test(status), 'idle Chromium process has exited');
console.log('Verified bounded idle browser lifetime and Chromium process cleanup.');
