import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect as netConnect } from 'node:net'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const dataDir = '/data/gateway'
const tlsDir = join(dataDir, 'tls')
const authPath = join(dataDir, 'auth.json')
const backend = new URL(process.env.HARNESS_BACKEND_URL || 'http://127.0.0.1:3080')
const httpsPort = integer('HARNESS_HTTPS_PORT', 3443)
const publicHttpsPort = integer('HARNESS_PUBLIC_HTTPS_PORT', httpsPort)
const caPort = integer('HARNESS_CA_PORT', 3081)
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

function hashPassword(password, salt, iterations) {
  return pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex')
}

function loadAuth() {
  if (existsSync(authPath)) return JSON.parse(readFileSync(authPath, 'utf8'))
  const username = process.env.HARNESS_AUTH_USERNAME || 'harness'
  const password = randomBytes(18).toString('base64url')
  const salt = randomBytes(16).toString('hex')
  const iterations = 240000
  const auth = { username, salt, iterations, hash: hashPassword(password, salt, iterations) }
  atomicJson(authPath, auth)
  process.stdout.write(`DeepSeek Harness initial credentials: ${username} / ${password}\n`)
  process.stdout.write('The plaintext password is shown only on this first start. Delete data/gateway/auth.json to regenerate it.\n')
  return auth
}

function authenticated(req, auth) {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return false
  let decoded
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
  } catch {
    return false
  }
  const separator = decoded.indexOf(':')
  if (separator < 0) return false
  const username = decoded.slice(0, separator)
  const password = decoded.slice(separator + 1)
  const expectedUser = Buffer.from(auth.username)
  const receivedUser = Buffer.from(username)
  const expectedHash = Buffer.from(auth.hash, 'hex')
  const receivedHash = Buffer.from(hashPassword(password, auth.salt, auth.iterations), 'hex')
  return expectedUser.length === receivedUser.length
    && expectedHash.length === receivedHash.length
    && timingSafeEqual(expectedUser, receivedUser)
    && timingSafeEqual(expectedHash, receivedHash)
}

function httpsAuthority(hostname, port) {
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname
  return new URL(`https://${host}:${port}`).host
}

const externalAuthorities = new Set([
  httpsAuthority(process.env.HARNESS_TLS_IP || '127.0.0.1', publicHttpsPort),
  httpsAuthority(process.env.HARNESS_TLS_DNS || 'deepseek-harness.local', publicHttpsPort),
  httpsAuthority('127.0.0.1', publicHttpsPort),
  httpsAuthority('localhost', publicHttpsPort),
])

function externallyTrusted(req) {
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let authority
  try {
    authority = new URL(`https://${host}`).host
  } catch {
    return false
  }
  if (!externalAuthorities.has(authority)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  if (typeof origin !== 'string') return false
  try {
    const parsed = new URL(origin)
    return parsed.protocol === 'https:' && parsed.host === authority
  } catch {
    return false
  }
}

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

function proxy(req, res) {
  const headers = { ...req.headers }
  delete headers.connection
  delete headers.authorization
  delete headers['proxy-authorization']
  headers.host = backend.host
  if (headers.origin !== undefined) headers.origin = backend.origin
  headers['x-forwarded-proto'] = 'https'
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

function proxyUpgrade(req, socket, head) {
  const upstream = netConnect(Number.parseInt(backend.port || '80', 10), backend.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
    const headers = { ...req.headers }
    delete headers.authorization
    delete headers['proxy-authorization']
    headers.host = backend.host
    if (headers.origin !== undefined) headers.origin = backend.origin
    headers['x-forwarded-proto'] = 'https'
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
const tls = ensureTls()

const caServer = createHttpServer((req, res) => {
  const path = new URL(req.url || '/', 'http://local').pathname
  if (path === '/healthz') {
    json(res, 200, { status: 'ok' })
    return
  }
  if (path === '/ca.crt') {
    const body = readFileSync(tls.caCert)
    res.writeHead(200, {
      'content-disposition': 'attachment; filename="deepseek-harness-local-ca.crt"',
      'content-length': String(body.length),
      'content-type': 'application/x-x509-ca-cert',
    })
    res.end(body)
    return
  }
  res.writeHead(302, {
    location: `https://${httpsAuthority(process.env.HARNESS_TLS_IP || '127.0.0.1', publicHttpsPort)}/`,
  })
  res.end()
})

const httpsServer = createHttpsServer({
  key: readFileSync(tls.serverKey),
  cert: readFileSync(tls.serverCert),
}, async (req, res) => {
  const path = new URL(req.url || '/', 'https://local').pathname
  if (path === '/healthz') {
    json(res, 200, { status: 'ok' })
    return
  }
  if (!authenticated(req, auth)) {
    challenge(res)
    return
  }
  if (!externallyTrusted(req)) {
    forbid(res)
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
  proxy(req, res)
})

httpsServer.on('upgrade', (req, socket, head) => {
  if (!authenticated(req, auth)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="DeepSeek Harness"\r\nConnection: close\r\n\r\n')
    return
  }
  if (!externallyTrusted(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    return
  }
  proxyUpgrade(req, socket, head)
})

caServer.listen(caPort, '0.0.0.0', () => {
  process.stdout.write(`Harness local CA download: http://0.0.0.0:${caPort}/ca.crt\n`)
})
httpsServer.listen(httpsPort, '0.0.0.0', () => {
  process.stdout.write(`Harness authenticated HTTPS gateway: https://0.0.0.0:${httpsPort}/\n`)
})

function shutdown() {
  caServer.close()
  httpsServer.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
