/** Pure helpers for redirects and shareable links (no React; covered by links.test.ts). */

const PUBLIC_PATHS = ['/login', '/signup']

export const isPublicPath = (pathname: string) => PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))

/** An in-app path from a `?next=` value, or null when it is missing/unsafe (absolute URLs, //host, auth pages). */
export function safeNext(raw: string | null | undefined): string | null {
  if (!raw) return null
  let value = raw.trim()
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null
  if (/[\u0000-\u001f]/.test(value)) return null
  try {
    // resolve dot segments / encoded tricks against a dummy origin and make sure we stay on it
    const url = new URL(value, 'https://app.invalid')
    if (url.origin !== 'https://app.invalid') return null
    value = `${url.pathname}${url.search}${url.hash}`
  } catch {
    return null
  }
  if (value.startsWith('//')) return null // "/..//evil.com" normalises to a protocol-relative URL
  return isPublicPath(value.split(/[?#]/)[0]) ? null : value
}

/** "/login" or "/login?next=<path>" for the page the user tried to open. */
export function loginPath(from: string | null | undefined) {
  const next = safeNext(from)
  return next && next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login'
}

/**
 * Where to go after signing in while LinkedIn isn't connected: "/connect", carrying the page the user
 * wanted as "?next=" so the Connect page can continue there.
 */
export function connectPath(from: string | null | undefined) {
  const next = safeNext(from)
  return next && next !== '/' && next.split(/[?#]/)[0] !== '/connect' ? `/connect?next=${encodeURIComponent(next)}` : '/connect'
}

/** Absolute URL for links the API may return app-relative (e.g. invite links). */
export function absoluteUrl(url: string, origin: string) {
  try {
    return new URL(url, origin).toString()
  } catch {
    return url
  }
}
