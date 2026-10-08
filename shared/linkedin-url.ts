/** LinkedIn URL parsing shared by the lead importer (frontend) and the API (backend). */

const PROFILE_RE = /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/([^/?#\s]+)\/?(?:[?#].*)?$/i
const SEARCH_RE = /^https?:\/\/(www\.)?linkedin\.com\/search\/results\/people\/?(\?.*)?$/i

/** Member-URN ids ("ACoAAB…") are case-sensitive, unlike vanity ids. */
const MEMBER_ID_RE = /^ACo[A-Za-z0-9_-]{20,}$/

/** "mike-johnson-19181" from any profile URL variant, or null. Decoded; vanity ids are lower-cased. */
export function publicIdFromUrl(url: string): string | null {
  const m = PROFILE_RE.exec(url.trim())
  if (!m) return null
  let id = m[2]
  try {
    id = decodeURIComponent(id)
  } catch {
    /* keep the raw id */
  }
  return MEMBER_ID_RE.test(id) ? id : id.toLowerCase()
}

/** Canonical form used for storage and de-duplication. */
export function normalizeProfileUrl(url: string): string | null {
  const id = publicIdFromUrl(url)
  return id ? `https://www.linkedin.com/in/${encodeURIComponent(id)}/` : null
}

export function isValidSearchUrl(url: string) {
  return SEARCH_RE.test(url.trim())
}

/** Split pasted text into unique valid profile URLs (normalized) and invalid lines. */
export function parseProfileUrls(raw: string) {
  const tokens = raw.split(/[\n,\s]+/).map((t) => t.trim()).filter(Boolean)
  const valid: string[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  for (const t of tokens) {
    const norm = normalizeProfileUrl(t)
    if (!norm) invalid.push(t)
    else if (!seen.has(norm)) {
      seen.add(norm)
      valid.push(norm)
    }
  }
  return { valid, invalid }
}

/** Best-effort readable name from a public id like "mike-johnson-1918171691". */
export function nameFromPublicId(id: string) {
  if (MEMBER_ID_RE.test(id)) return { firstName: 'LinkedIn', lastName: 'Member' }
  const parts = id.split('-').filter((p) => p && !/\d/.test(p))
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  return {
    firstName: cap(parts[0] ?? 'LinkedIn'),
    lastName: parts.slice(1).map(cap).join(' ') || 'Member',
  }
}
