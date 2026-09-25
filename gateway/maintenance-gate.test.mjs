import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maintenanceActive, maintenanceReadAllowed } from './maintenance-gate.mjs';

test('cutover gates every writable route and all ordinary client assets until commitment', () => {
  for (const path of ['/api/session/create', '/api/session/cancel', '/api/settings/mutate', '/local-stt/transcriptions']) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) assert.equal(maintenanceReadAllowed(method, path), false);
  }
  assert.equal(maintenanceReadAllowed('GET', '/healthz'), true);
  assert.equal(maintenanceReadAllowed('GET', '/'), true);
  assert.equal(maintenanceReadAllowed('POST', '/'), false);
});

test('publishing the deployment is one atomic gate removal without restarting services', () => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-maintenance-'));
  try {
    const token = join(root, 'launch-token'), gate = join(root, '.deployment-maintenance');
    assert.equal(maintenanceActive(token), false);
    writeFileSync(gate, 'pending');
    assert.equal(maintenanceActive(token), true);
    rmSync(gate);
    assert.equal(maintenanceActive(token), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
