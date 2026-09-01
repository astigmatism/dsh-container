export function httpsAuthority(hostname, port) {
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname
  return new URL(`https://${host}:${port}`).host
}

export function isTopLevelGetNavigation(req) {
  return req.method === 'GET'
    && req.headers['sec-fetch-mode'] === 'navigate'
    && req.headers['sec-fetch-dest'] === 'document'
}

function requestAuthority(req) {
  const host = req.headers.host
  if (typeof host !== 'string') return null
  try {
    return new URL(`https://${host}`).host
  } catch {
    return null
  }
}

export function authorityTrusted(req, externalAuthorities) {
  const authority = requestAuthority(req)
  return authority !== null && externalAuthorities.has(authority)
}

export function externallyTrusted(req, externalAuthorities, protocol = 'https:') {
  const authority = requestAuthority(req)
  if (authority === null) return false
  if (!externalAuthorities.has(authority)) return false

  // Browsers can preserve a cross-site classification across navigation
  // redirects while omitting Sec-Fetch-User on the redirected request. Permit
  // top-level GET navigation (which the same-origin policy keeps unreadable to
  // the initiating site); cross-site APIs, forms, and upgrades stay denied.
  if (req.headers['sec-fetch-site'] === 'cross-site' && !isTopLevelGetNavigation(req)) return false

  const origin = req.headers.origin
  if (origin === undefined) return true
  if (typeof origin !== 'string') return false
  try {
    const parsed = new URL(origin)
    return parsed.protocol === protocol && parsed.host === authority
  } catch {
    return false
  }
}
