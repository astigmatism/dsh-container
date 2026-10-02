import { createServer, request } from 'node:http';
import { connect, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

// A browser-wide proxy applies the same policy to navigation, redirects,
// subresources, WebSockets and requests made by page scripts.
export function publicAddress(address) {
  const value = address.toLowerCase();
  if (value.startsWith('::ffff:')) return publicAddress(value.slice(7));
  if (isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)));
  }
  // Only globally routable IPv6 unicast; reject local, mapped and transition ranges.
  return isIP(value) === 6 && /^[23]/.test(value) &&
    !/^2001:0?db8:/.test(value) && !value.startsWith('2002:') && !/^2001:(?:0{1,4}:|:)/.test(value);
}

export async function destination(hostname, allowPrivate, resolver = lookup) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await resolver(host, { all: true });
  if (!addresses.length || (!allowPrivate && addresses.some(row => !publicAddress(row.address)))) {
    throw new Error('Private browser destination is disabled for this deployment');
  }
  return addresses[0].address; // Connect to the validated IP; never resolve a second time.
}

export async function startBrowserProxy({ allowPrivate = false } = {}) {
  const sockets = new Set();
  const track = socket => { if (!sockets.has(socket)) { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); } return socket; };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url);
      if (url.protocol !== 'http:' || url.username || url.password) throw new Error('Invalid proxy URL');
      const address = await destination(url.hostname, allowPrivate);
      const headers = { ...req.headers, host: url.host };
      delete headers['proxy-authorization']; delete headers['proxy-connection'];
      const upstream = request({ hostname: address, port: url.port || 80,
        method: req.method, path: url.pathname + url.search, headers }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      upstream.on('socket', track);
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      upstream.setTimeout(120000, () => upstream.destroy());
      res.once('close', () => upstream.destroy()); req.pipe(upstream);
    } catch { res.writeHead(403); res.end('Browser destination blocked'); }
  });
  server.on('connection', track);
  server.on('upgrade', async (req, client, head) => {
    try {
      const url = new URL(req.url);
      if (!['ws:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid WebSocket destination');
      const address = await destination(url.hostname, allowPrivate);
      const headers = { ...req.headers, host: url.host };
      delete headers['proxy-authorization']; delete headers['proxy-connection'];
      const upstream = request({ hostname: address, port: url.port || 80, method: req.method, path: url.pathname + url.search, headers });
      upstream.on('socket', track);
      upstream.on('upgrade', (res, socket, incoming) => {
        client.write(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n` + res.rawHeaders.reduce((text, value, i, rows) => i % 2 ? text : text + `${value}: ${rows[i + 1]}\r\n`, '') + '\r\n');
        if (incoming.length) client.write(incoming);
        if (head.length) socket.write(head);
        client.pipe(socket); socket.pipe(client);
        client.once('close', () => socket.destroy()); socket.once('close', () => client.destroy());
        client.on('error', () => socket.destroy()); socket.on('error', () => client.destroy());
      });
      upstream.on('response', res => { client.end(`HTTP/1.1 ${res.statusCode} Rejected\r\nContent-Length: 0\r\n\r\n`); res.resume(); });
      upstream.on('error', () => client.destroy());
      upstream.setTimeout(10000, () => upstream.destroy());
      upstream.end();
    } catch { client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); }
  });
  server.on('connect', async (req, client, head) => {
    try {
      const target = new URL('https://' + req.url);
      if (target.username || target.password || target.pathname !== '/') throw new Error('Invalid tunnel destination');
      const address = await destination(target.hostname, allowPrivate);
      const upstream = track(connect(Number(target.port || 443), address));
      upstream.setTimeout(120000, () => upstream.destroy());
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
      client.once('close', () => upstream.destroy()); upstream.once('close', () => client.destroy());
    } catch { client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }) };
}
