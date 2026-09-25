import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function maintenanceActive(tokenFile) {
  return existsSync(join(dirname(tokenFile), '.deployment-maintenance'));
}

export function maintenanceReadAllowed(method, path) {
  return method === 'GET' && ['/', '/healthz', '/ca.crt'].includes(path);
}
