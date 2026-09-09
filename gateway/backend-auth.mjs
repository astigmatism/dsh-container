import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const COOKIE_PATTERN = /^dsh-auth-[A-Za-z0-9_-]+=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

export function readLaunchToken(path) {
  const token = readFileSync(path, 'utf8').trim()
  if (!TOKEN_PATTERN.test(token)) throw new Error('Harness backend launch-token file is invalid')
  return token
}

export function backendSessionCookie(setCookie) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie]
  for (const value of values) {
    const pair = String(value).split(';', 1)[0]
    if (COOKIE_PATTERN.test(pair)) return pair
  }
  throw new Error('Harness backend token exchange did not return a valid session cookie')
}

export function appendBackendCookie(forwarded, backendCookie) {
  return forwarded === null || forwarded === undefined || forwarded === ''
    ? backendCookie
    : `${forwarded}; ${backendCookie}`
}

function exchangeToken(backend, token) {
  if (backend.protocol !== 'http:') throw new Error('Harness backend authentication requires an HTTP loopback endpoint')
  const url = new URL('/', backend)
  url.searchParams.set('token', token)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: backend.hostname,
      port: backend.port || 80,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers: { host: backend.host },
    }, response => {
      response.resume()
      response.once('end', () => {
        if (response.statusCode !== 303) {
          reject(new Error(`Harness backend token exchange returned HTTP ${response.statusCode || 0}`))
          return
        }
        try {
          resolve(backendSessionCookie(response.headers['set-cookie']))
        } catch (error) {
          reject(error)
        }
      })
    })
    request.once('error', reject)
    request.end()
  })
}

export function createBackendAuthenticator(backend, tokenFile) {
  let activeToken = null
  let activeCookie = null
  let pending = null

  return {
    async cookie() {
      const token = readLaunchToken(tokenFile)
      if (token === activeToken && activeCookie !== null) return activeCookie
      if (pending?.token === token) return pending.promise

      const promise = exchangeToken(backend, token)
      pending = { token, promise }
      try {
        const cookie = await promise
        activeToken = token
        activeCookie = cookie
        return cookie
      } finally {
        if (pending?.promise === promise) pending = null
      }
    },
  }
}
