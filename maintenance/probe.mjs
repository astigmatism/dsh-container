// Runs inside the gateway: connect locally, verify the configured TLS identity.
// Credentials come only from the gateway environment and never leave this process.
import https from 'node:https';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';

const identity = process.env.HARNESS_TLS_VERIFY_NAME || process.env.HARNESS_TLS_IP || '127.0.0.1';
const ca = readFileSync('/data/gateway/tls/ca.crt');
const port = Number(process.env.HARNESS_HTTPS_PORT || 3443);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid gateway port');
if (!process.env.HARNESS_AUTH_USERNAME || !process.env.HARNESS_AUTH_PASSWORD) throw new Error('Missing gateway login');
const headers = {
  host: `${identity}:${process.env.HARNESS_PUBLIC_HTTPS_PORT || port}`,
  authorization: `Basic ${Buffer.from(`${process.env.HARNESS_AUTH_USERNAME}:${process.env.HARNESS_AUTH_PASSWORD}`).toString('base64')}`,
};
for (const path of ['/healthz', '/']) {
  await new Promise((resolve, reject) => {
    const request = https.get({
      hostname: '127.0.0.1', port, path, ca, headers,
      checkServerIdentity: (_host, certificate) => tls.checkServerIdentity(identity, certificate),
    }, response => {
      response.resume();
      response.on('end', () => response.statusCode === 200 ? resolve() : reject(new Error('Gateway rejected authenticated probe')));
    });
    request.setTimeout(15000, () => request.destroy(new Error('Gateway probe timed out')));
    request.on('error', reject);
  });
}
console.log('Authenticated gateway and TLS identity verified');
