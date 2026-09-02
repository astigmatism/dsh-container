// Test fixture: minimal authenticated-TLS gateway stand-in.
//
// Serves /healthz over HTTPS exactly like the real gateway listener does in
// its own network namespace (bound on 0.0.0.0). The certificate/key paths
// come from the environment so each test case can present a different
// certificate (valid IP SAN, no IP SAN, ...) while the verification logic
// under test remains the real one.
import { createServer } from 'node:https'
import { readFileSync } from 'node:fs'

const keyPath = process.env.GATEWAY_TEST_KEY || '/certs/server.key'
const certPath = process.env.GATEWAY_TEST_CERT || '/certs/server.crt'
const port = Number.parseInt(process.env.HARNESS_HTTPS_PORT || '3443', 10)

const server = createServer(
  { key: readFileSync(keyPath), cert: readFileSync(certPath) },
  (req, res) => {
    const path = new URL(req.url || '/', 'https://local').pathname
    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"status":"ok"}\n')
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found\n')
  },
)
server.on('tlsclienterror', () => {})
server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`ready ${port}\n`)
})
