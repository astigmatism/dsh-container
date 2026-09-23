import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE_NAME = 'dsh_session'

export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, path)
}

function loadSessions(path, now) {
  let parsed = null
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return new Map()
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map()
  const sessions = new Map()
  for (const [token, expiresAt] of Object.entries(parsed)) {
    if (typeof token === 'string' && Number.isSafeInteger(expiresAt) && expiresAt > now()) {
      sessions.set(token, expiresAt)
    }
  }
  return sessions
}

export function passwordHash(password, salt, iterations) {
  return pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex')
}

export function createCredentialRecord(username, password, options = {}) {
  const salt = options.salt || randomBytes(16).toString('hex')
  const iterations = options.iterations || 240000
  return { username, salt, iterations, hash: passwordHash(password, salt, iterations) }
}

export function credentialsValid(auth, username, password) {
  const expectedUser = Buffer.from(auth.username)
  const receivedUser = Buffer.from(username)
  const expectedHash = Buffer.from(auth.hash, 'hex')
  const receivedHash = Buffer.from(passwordHash(password, auth.salt, auth.iterations), 'hex')
  return expectedUser.length === receivedUser.length
    && expectedHash.length === receivedHash.length
    && timingSafeEqual(expectedUser, receivedUser)
    && timingSafeEqual(expectedHash, receivedHash)
}

export function deploymentCredentials(env) {
  const username = env.HARNESS_AUTH_USERNAME || ''
  const password = env.HARNESS_AUTH_PASSWORD || ''
  if (!username || /[:\r\n\0]/.test(username) || password.length < 8 || /[\r\n\0]/.test(password)) {
    throw new Error('Configure a gateway username and password of at least 8 characters in the private deployment .env; no shared login is provided')
  }
  return { username, password }
}

export function sourceManagedCredentials(existing, username, password, options = {}) {
  try {
    if (existing && credentialsValid(existing, username, password)) {
      return { auth: existing, changed: false }
    }
  } catch {}
  return { auth: createCredentialRecord(username, password, options), changed: true }
}

function basicCredentials(header) {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return null
  let decoded
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
  } catch {
    return null
  }
  const separator = decoded.indexOf(':')
  if (separator < 0) return null
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) }
}

function cookieValue(header, name) {
  if (typeof header !== 'string') return null
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue
    return part.slice(separator + 1).trim()
  }
  return null
}

export function withoutSessionCookie(header) {
  if (typeof header !== 'string') return null
  const remaining = header.split(';').map(part => part.trim()).filter(part => {
    const separator = part.indexOf('=')
    return separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE_NAME
  })
  return remaining.length > 0 ? remaining.join('; ') : null
}

export function createSessionAuthenticator(auth, options = {}) {
  const now = options.now || (() => Date.now())
  const ttlMs = options.ttlMs || DEFAULT_SESSION_TTL_MS
  const sessionsPath = typeof options.sessionsPath === 'string' && options.sessionsPath !== ''
    ? options.sessionsPath
    : null
  const sessions = sessionsPath === null ? new Map() : loadSessions(sessionsPath, now)

  function persist() {
    if (sessionsPath === null) return
    atomicJson(sessionsPath, Object.fromEntries(sessions))
  }

  function issue() {
    const token = randomBytes(32).toString('base64url')
    sessions.set(token, now() + ttlMs)
    persist()
    return token
  }

  function acceptsRequest(req) {
    const basic = basicCredentials(req.headers.authorization)
    if (basic && credentialsValid(auth, basic.username, basic.password)) return true
    const token = cookieValue(req.headers.cookie, SESSION_COOKIE_NAME)
    if (!token) return false
    const expiresAt = sessions.get(token)
    if (expiresAt === undefined) return false
    if (expiresAt <= now()) {
      sessions.delete(token)
      persist()
      return false
    }
    return true
  }

  function setCookieHeader(token, options = {}) {
    const secure = options.secure !== false ? '; Secure' : ''
    return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}`
  }

  return { acceptsRequest, issue, setCookieHeader }
}
