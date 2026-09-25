import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { externalTls } from './external-tls.mjs';

test('external TLS validates the identity and key without changing files or needing a CA key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-external-tls-'));
  const openssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  const hashes = () => Object.fromEntries(readdirSync(dir).map(name => [name, readFileSync(join(dir, name)).toString('base64')]));
  try {
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'issuer.key', '-out', 'ca.crt', '-days', '1',
      '-subj', '/CN=Synthetic test authority', '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'nameConstraints=critical,permitted;IP:192.0.2.0/255.255.255.0');
    openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'request.pem', '-subj', '/O=Synthetic fixture');
    writeFileSync(join(dir, 'extensions'), 'subjectAltName=IP:192.0.2.17\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n');
    openssl('x509', '-req', '-in', 'request.pem', '-CA', 'ca.crt', '-CAkey', 'issuer.key', '-CAcreateserial',
      '-out', 'server.crt', '-days', '1', '-extfile', 'extensions');
    rmSync(join(dir, 'issuer.key'));
    const before = hashes();
    assert.equal(externalTls(dir, '192.0.2.17').serverKey, join(dir, 'server.key'));
    for (const identity of ['127.0.0.1', 'unrelated.test', '']) {
      assert.throws(() => externalTls(dir, identity), /missing or invalid/);
    }
    assert.deepEqual(hashes(), before);
    openssl('genrsa', '-out', 'server.key', '2048');
    const wrongKey = hashes();
    assert.throws(() => externalTls(dir, '192.0.2.17'), /missing or invalid/);
    assert.deepEqual(hashes(), wrongKey);
    rmSync(join(dir, 'server.crt'));
    const missing = hashes();
    assert.throws(() => externalTls(dir, '192.0.2.17'), /missing or invalid/);
    assert.deepEqual(hashes(), missing);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
