import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect as netConnect } from 'node:net'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { authorityTrusted, externallyTrusted, httpsAuthority, isTopLevelGetNavigation } from './request-trust.mjs'
import {
  createSessionAuthenticator,
  credentialsValid,
  sourceManagedCredentials,
  withoutSessionCookie,
} from './session-auth.mjs'

const dataDir = '/data/gateway'
const tlsDir = join(dataDir, 'tls')
const authPath = join(dataDir, 'auth.json')
const backend = new URL(process.env.HARNESS_BACKEND_URL || 'http://127.0.0.1:3080')
const httpsPort = integer('HARNESS_HTTPS_PORT', 3443)
const publicHttpsPort = integer('HARNESS_PUBLIC_HTTPS_PORT', httpsPort)
const httpPort = integer('HARNESS_HTTP_PORT', 3081)
const publicHttpPort = integer('HARNESS_PUBLIC_HTTP_PORT', httpPort)
const sttMaxBytes = integer('STT_MAX_BYTES', 32 * 1024 * 1024)
const sttTimeoutMs = integer('STT_TIMEOUT_MS', 120000)
const sttMaxRecordSeconds = integer('STT_MAX_RECORD_SECONDS', 300)
const sttBaseUrl = (process.env.STT_BASE_URL || '').replace(/\/+$/, '')
const sttModel = process.env.STT_MODEL || 'large-v3-turbo'
const sttKeyFile = process.env.STT_API_KEY_FILE || '/run/secrets/stt_api_key'
const ttsMaxBytes = integer('TTS_MAX_BYTES', 1024 * 1024)
const ttsTimeoutMs = integer('TTS_TIMEOUT_MS', 180000)
const ttsBaseUrl = (process.env.TTS_BASE_URL || '').replace(/\/+$/, '')
const ttsModel = process.env.TTS_MODEL || 'tts-1'
const ttsVoice = process.env.TTS_VOICE || 'af_heart'
const ttsKeyFile = process.env.TTS_API_KEY_FILE || '/run/secrets/tts_api_key'
const LOGIN_PATH = '/__harness/login'

function integer(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, path)
}

function loadAuth() {
  const username = process.env.HARNESS_AUTH_USERNAME || 'astigmatism'
  const password = process.env.HARNESS_AUTH_PASSWORD || 'ICar12..'
  let existing = null
  try { existing = JSON.parse(readFileSync(authPath, 'utf8')) } catch {}
  const { auth, changed } = sourceManagedCredentials(existing, username, password)
  if (changed) {
    atomicJson(authPath, auth)
    process.stdout.write(`Activated the source-managed gateway identity for ${username}.\n`)
  }
  return auth
}

const httpsAuthorities = new Set([
  httpsAuthority(process.env.HARNESS_TLS_IP || '127.0.0.1', publicHttpsPort),
  httpsAuthority(process.env.HARNESS_TLS_DNS || 'deepseek-harness.local', publicHttpsPort),
  httpsAuthority('127.0.0.1', publicHttpsPort),
  httpsAuthority('localhost', publicHttpsPort),
])
const httpAuthorities = new Set([
  httpsAuthority(process.env.HARNESS_TLS_IP || '127.0.0.1', publicHttpPort),
  httpsAuthority(process.env.HARNESS_TLS_DNS || 'deepseek-harness.local', publicHttpPort),
  httpsAuthority('127.0.0.1', publicHttpPort),
  httpsAuthority('localhost', publicHttpPort),
])

function forbid(res) {
  res.writeHead(403, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
  })
  res.end('Forbidden\n')
}

function challenge(res) {
  res.writeHead(401, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'www-authenticate': 'Basic realm="DeepSeek Harness", charset="UTF-8"',
  })
  res.end('Authentication required\n')
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character])
}

function loginPage(res, auth, status = 200, message = '') {
  const body = Buffer.from(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — DeepSeek Harness</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1220;color:#eef3ff;font:16px system-ui,sans-serif}.card{width:min(92vw,26rem);padding:2rem;border:1px solid #2b3958;border-radius:16px;background:#151c2e;box-shadow:0 20px 60px #0008}h1{margin:0 0 .5rem;font-size:1.5rem}p{color:#aebbd5}.error{color:#ffb4b4}label{display:block;margin:1rem 0 .35rem}input{width:100%;padding:.75rem;border:1px solid #3b4d73;border-radius:8px;background:#0d1220;color:inherit;font:inherit}button{width:100%;margin-top:1.25rem;padding:.8rem;border:0;border-radius:8px;background:#7aa2ff;color:#071126;font:700 1rem system-ui;cursor:pointer}
</style></head><body><main class="card"><h1>DeepSeek Harness</h1><p>Sign in to continue through the authenticated gateway.</p>${message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : ''}<form method="post" action="${LOGIN_PATH}"><label for="username">Username</label><input id="username" name="username" autocomplete="username" value="${escapeHtml(auth.username)}" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus><button type="submit">Sign in</button></form></main></body></html>`)
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': String(body.length),
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'content-type': 'text/html; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function openssl(args) {
  const result = spawnSync('openssl', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`openssl ${args[0]} failed: ${result.stderr.trim()}`)
}

function ensureTls() {
  mkdirSync(tlsDir, { recursive: true })
  const caKey = join(tlsDir, 'ca.key')
  const caCert = join(tlsDir, 'ca.crt')
  const serverKey = join(tlsDir, 'server.key')
  const serverCert = join(tlsDir, 'server.crt')
  const identityPath = join(tlsDir, 'identity.json')
  const ip = process.env.HARNESS_TLS_IP || '127.0.0.1'
  const dns = process.env.HARNESS_TLS_DNS || 'deepseek-harness.local'
  const identity = { ip, dns }

  if (!existsSync(caKey) || !existsSync(caCert)) {
    openssl(['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:3072', '-out', caKey])
    openssl([
      'req', '-x509', '-new', '-key', caKey, '-sha256', '-days', '3650',
      '-subj', '/CN=DeepSeek Harness Local CA',
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      '-out', caCert,
    ])
  }

  let current = null
  try { current = JSON.parse(readFileSync(identityPath, 'utf8')) } catch {}
  if (!existsSync(serverKey) || !existsSync(serverCert) || JSON.stringify(current) !== JSON.stringify(identity)) {
    const csr = join(tlsDir, 'server.csr')
    const ext = join(tlsDir, 'server.ext')
    rmSync(serverKey, { force: true })
    rmSync(serverCert, { force: true })
    writeFileSync(ext, [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      `subjectAltName=IP:${ip},IP:127.0.0.1,DNS:${dns},DNS:localhost`,
      '',
    ].join('\n'), { mode: 0o600 })
    openssl(['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', serverKey])
    openssl(['req', '-new', '-key', serverKey, '-subj', `/CN=${dns}`, '-out', csr])
    openssl([
      'x509', '-req', '-in', csr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial',
      '-days', '825', '-sha256', '-extfile', ext, '-out', serverCert,
    ])
    rmSync(csr, { force: true })
    atomicJson(identityPath, identity)
  }

  return { caCert, serverKey, serverCert }
}

function readSecret(path) {
  try {
    const value = readFileSync(path, 'utf8').trim()
    return value === '' ? null : value
  } catch {
    return null
  }
}

function json(res, status, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`)
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': String(body.length),
    'content-type': 'application/json; charset=utf-8',
  })
  res.end(body)
}

async function readBody(req, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw Object.assign(new Error('Request exceeds the configured upload limit'), { statusCode: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function handleLogin(req, res, auth, sessions, secureCookie) {
  if (req.method === 'GET') {
    loginPage(res, auth)
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'GET, POST' })
    res.end()
    return
  }
  try {
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (contentType !== 'application/x-www-form-urlencoded') {
      loginPage(res, auth, 415, 'The sign-in request had an unsupported format.')
      return
    }
    const form = new URLSearchParams((await readBody(req, 8192)).toString('utf8'))
    if (!credentialsValid(auth, form.get('username') || '', form.get('password') || '')) {
      loginPage(res, auth, 401, 'The username or password was not accepted.')
      return
    }
    const token = sessions.issue()
    res.writeHead(303, {
      'cache-control': 'no-store',
      location: '/',
      'set-cookie': sessions.setCookieHeader(token, { secure: secureCookie }),
    })
    res.end()
  } catch (error) {
    loginPage(res, auth, 400, error instanceof Error ? error.message : String(error))
  }
}

async function transcribe(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  const contentType = req.headers['content-type'] || ''
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    json(res, 415, { error: { message: 'Expected a multipart audio upload' } })
    return
  }
  const key = readSecret(sttKeyFile)
  if (sttBaseUrl === '' || key === null) {
    json(res, 503, { error: { message: 'Speech-to-text is not configured' } })
    return
  }
  try {
    const body = await readBody(req, sttMaxBytes)
    const upstream = await fetch(`${sttBaseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': contentType,
      },
      body,
      signal: AbortSignal.timeout(sttTimeoutMs),
    })
    const responseBody = Buffer.from(await upstream.arrayBuffer())
    res.writeHead(upstream.status, {
      'cache-control': 'no-store',
      'content-length': String(responseBody.length),
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    })
    res.end(responseBody)
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502
    json(res, status, { error: { message: error instanceof Error ? error.message : String(error) } })
  }
}

async function synthesize(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  const contentType = req.headers['content-type'] || ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    json(res, 415, { error: { message: 'Expected a JSON speech request' } })
    return
  }
  const key = readSecret(ttsKeyFile)
  if (ttsBaseUrl === '' || key === null) {
    json(res, 503, { error: { message: 'Text-to-speech is not configured' } })
    return
  }
  try {
    const requestBody = await readBody(req, ttsMaxBytes)
    let payload
    try {
      payload = JSON.parse(requestBody.toString('utf8'))
    } catch {
      json(res, 400, { error: { message: 'Speech request is not valid JSON' } })
      return
    }
    if (payload === null || Array.isArray(payload) || typeof payload !== 'object') {
      json(res, 400, { error: { message: 'Speech request must be a JSON object' } })
      return
    }
    if (typeof payload.model !== 'string' || payload.model === '') payload.model = ttsModel
    if (typeof payload.voice !== 'string' || payload.voice === '') payload.voice = ttsVoice
    const body = Buffer.from(JSON.stringify(payload))
    const upstream = await fetch(`${ttsBaseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        accept: req.headers.accept || 'audio/mpeg',
        authorization: `Bearer ${key}`,
        'content-type': contentType,
      },
      body,
      signal: AbortSignal.timeout(ttsTimeoutMs),
    })
    const responseBody = Buffer.from(await upstream.arrayBuffer())
    res.writeHead(upstream.status, {
      'cache-control': 'no-store',
      'content-length': String(responseBody.length),
      'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
    })
    res.end(responseBody)
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502
    json(res, status, { error: { message: error instanceof Error ? error.message : String(error) } })
  }
}

function proxy(req, res, forwardedProtocol) {
  const headers = { ...req.headers }
  delete headers.connection
  delete headers.authorization
  delete headers['proxy-authorization']
  const forwardedCookie = withoutSessionCookie(headers.cookie)
  if (forwardedCookie === null) delete headers.cookie
  else headers.cookie = forwardedCookie
  headers.host = backend.host
  if (headers.origin !== undefined) headers.origin = backend.origin
  headers['x-forwarded-proto'] = forwardedProtocol
  headers['x-forwarded-host'] = req.headers.host || ''
  headers['x-forwarded-for'] = req.socket.remoteAddress || ''
  const upstream = httpRequest({
    hostname: backend.hostname,
    port: backend.port || 80,
    method: req.method,
    path: req.url,
    headers,
  }, response => {
    res.writeHead(response.statusCode || 502, response.headers)
    response.pipe(res)
  })
  upstream.on('error', error => {
    if (!res.headersSent) json(res, 502, { error: { message: `Harness backend unavailable: ${error.message}` } })
    else res.destroy(error)
  })
  req.pipe(upstream)
}

function proxyUpgrade(req, socket, head, forwardedProtocol) {
  const upstream = netConnect(Number.parseInt(backend.port || '80', 10), backend.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
    const headers = { ...req.headers }
    delete headers.authorization
    delete headers['proxy-authorization']
    const forwardedCookie = withoutSessionCookie(headers.cookie)
    if (forwardedCookie === null) delete headers.cookie
    else headers.cookie = forwardedCookie
    headers.host = backend.host
    if (headers.origin !== undefined) headers.origin = backend.origin
    headers['x-forwarded-proto'] = forwardedProtocol
    headers['x-forwarded-host'] = req.headers.host || ''
    headers['x-forwarded-for'] = req.socket.remoteAddress || ''
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue
      if (Array.isArray(value)) {
        for (const item of value) lines.push(`${name}: ${item}`)
      } else {
        lines.push(`${name}: ${value}`)
      }
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
}

const auth = loadAuth()
const sessions = createSessionAuthenticator(auth)
const tls = ensureTls()

async function handleGateway(req, res, options) {
  const path = new URL(req.url || '/', `${options.protocol}//local`).pathname
  if (path === '/healthz') {
    json(res, 200, { status: 'ok' })
    return
  }
  if (options.serveCa && path === '/ca.crt') {
    const body = readFileSync(tls.caCert)
    res.writeHead(200, {
      'content-disposition': 'attachment; filename="deepseek-harness-local-ca.crt"',
      'content-length': String(body.length),
      'content-type': 'application/x-x509-ca-cert',
    })
    res.end(body)
    return
  }
  // The login form is only issued from an approved authority, and the single
  // source-managed identity cannot be switched by login CSRF. Some browsers
  // nevertheless classify its POST as cross-site or send an opaque Origin, so
  // authority-check the submission without rejecting it on navigation metadata.
  if (path === LOGIN_PATH && authorityTrusted(req, options.authorities)) {
    await handleLogin(req, res, auth, sessions, options.secureCookie)
    return
  }
  if (!externallyTrusted(req, options.authorities, `${options.protocol}`)) {
    forbid(res)
    return
  }
  if (!sessions.acceptsRequest(req)) {
    if (isTopLevelGetNavigation(req)) loginPage(res, auth)
    else challenge(res)
    return
  }
  if (path === '/local-stt/config') {
    const key = readSecret(sttKeyFile)
    json(res, 200, {
      enabled: sttBaseUrl !== '' && key !== null,
      model: sttModel,
      maxRecordSeconds: sttMaxRecordSeconds,
      ...(sttBaseUrl === '' || key === null ? { reason: 'Speech-to-text credentials are unavailable' } : {}),
    })
    return
  }
  if (path === '/local-stt/transcriptions') {
    await transcribe(req, res)
    return
  }
  if (path === '/local-tts/config') {
    const key = readSecret(ttsKeyFile)
    json(res, 200, {
      enabled: ttsBaseUrl !== '' && key !== null,
      model: ttsModel,
      voice: ttsVoice,
      ...(ttsBaseUrl === '' || key === null ? { reason: 'Text-to-speech credentials are unavailable' } : {}),
    })
    return
  }
  if (path === '/local-tts/speech') {
    await synthesize(req, res)
    return
  }
  proxy(req, res, options.protocol.slice(0, -1))
}

function handleUpgrade(req, socket, head, options) {
  if (!externallyTrusted(req, options.authorities, options.protocol)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    return
  }
  if (!sessions.acceptsRequest(req)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="DeepSeek Harness"\r\nConnection: close\r\n\r\n')
    return
  }
  proxyUpgrade(req, socket, head, options.protocol.slice(0, -1))
}

const httpOptions = {
  protocol: 'http:',
  authorities: httpAuthorities,
  secureCookie: false,
  serveCa: true,
}
const httpsOptions = {
  protocol: 'https:',
  authorities: httpsAuthorities,
  secureCookie: true,
  serveCa: false,
}

const httpServer = createHttpServer((req, res) => handleGateway(req, res, httpOptions))
const httpsServer = createHttpsServer({
  key: readFileSync(tls.serverKey),
  cert: readFileSync(tls.serverCert),
}, (req, res) => handleGateway(req, res, httpsOptions))

httpsServer.on('upgrade', (req, socket, head) => {
  handleUpgrade(req, socket, head, httpsOptions)
})
httpServer.on('upgrade', (req, socket, head) => {
  handleUpgrade(req, socket, head, httpOptions)
})

httpServer.listen(httpPort, '0.0.0.0', () => {
  process.stdout.write(`Harness authenticated HTTP gateway: http://0.0.0.0:${httpPort}/\n`)
  process.stdout.write(`Harness optional local CA download: http://0.0.0.0:${httpPort}/ca.crt\n`)
})
httpsServer.listen(httpsPort, '0.0.0.0', () => {
  process.stdout.write(`Harness authenticated HTTPS gateway: https://0.0.0.0:${httpsPort}/\n`)
})

function shutdown() {
  httpServer.close()
  httpsServer.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
