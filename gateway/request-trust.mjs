export function httpsAuthority(hostname, port) {
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname
  return new URL(`https://${host}:${port}`).host
}

export function isTopLevelGetNavigation(req) {
  return req.method === 'GET'
    && req.headers['sec-fetch-mode'] === 'navigate'
    && req.headers['sec-fetch-dest'] === 'document'
}

function isUserActivatedTopLevelGetNavigation(req) {
  return isTopLevelGetNavigation(req) && req.headers['sec-fetch-user'] === '?1'
}

export function externallyTrusted(req, externalAuthorities) {
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let authority
  try {
    authority = new URL(`https://${host}`).host
  } catch {
    return false
  }
  if (!externalAuthorities.has(authority)) return false

  // Browsers treat navigation from Service Portal's HTTP origin to this HTTPS
  // origin as cross-site. Permit only an explicit top-level GET navigation;
  // cross-site API calls, form submissions, and WebSocket upgrades stay denied.
  if (req.headers['sec-fetch-site'] === 'cross-site' && !isUserActivatedTopLevelGetNavigation(req)) return false

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
