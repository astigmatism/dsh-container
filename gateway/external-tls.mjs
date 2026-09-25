import { readFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// External identities are inputs, never generated state. In particular no CA
// private key or generator identity.json is required for this mode.
export function externalTls(directory, identity) {
  const caCert = join(directory, 'ca.crt');
  const serverKey = join(directory, 'server.key');
  const serverCert = join(directory, 'server.crt');
  try {
    const certificate = new X509Certificate(readFileSync(serverCert));
    const key = createPrivateKey(readFileSync(serverKey));
    const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' });
    if (!publicKey.equals(certificate.publicKey.export({ type: 'spki', format: 'der' }))) {
      throw new Error('key mismatch');
    }
    if (!identity || typeof identity !== 'string') throw new Error('missing identity');
    const result = spawnSync('openssl', ['verify', '-purpose', 'sslserver', '-CAfile', caCert,
      isIP(identity) ? '-verify_ip' : '-verify_hostname', identity, serverCert], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('untrusted identity');
  } catch {
    throw new Error('Externally provisioned TLS identity is missing or invalid; certificate files were not changed');
  }
  return { caCert, serverKey, serverCert };
}
