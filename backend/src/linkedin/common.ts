/** Small helpers shared by the simulated and the Playwright LinkedIn services. */

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)))

export const randInt = (min: number, max: number) => Math.floor(min + Math.random() * (Math.max(0, max - min) + 1))

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Per-key FIFO lock: calls for the same key run one at a time, other keys are unaffected. */
export function createKeyedMutex() {
  const tails = new Map<string, Promise<void>>()
  return async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const tail = prev.then(() => new Promise<void>((resolve) => (release = resolve)))
    tails.set(key, tail)
    await prev
    try {
      return await fn()
    } finally {
      release()
      if (tails.get(key) === tail) tails.delete(key)
    }
  }
}

/** "Jane van der Berg, PhD" → { firstName: "Jane", lastName: "van der Berg" } */
export function splitName(full: string) {
  const clean = full.replace(/\s+/g, ' ').trim().split(/,\s*/)[0]
  const parts = clean.split(' ').filter(Boolean)
  return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') }
}

/** Lower-case, accent-free, punctuation-free form of a person's name for comparisons. */
export function normalizeName(s: string) {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(',')[0]
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Loose equality for names as LinkedIn shows them ("Jane Doe" vs "Jane Doe, MBA" vs "Jane D."). */
export function sameName(a: string, b: string) {
  const x = normalizeName(a)
  const y = normalizeName(b)
  if (!x || !y) return false
  if (x === y) return true
  const [xf, ...xr] = x.split(' ')
  const [yf, ...yr] = y.split(' ')
  if (xf !== yf) return false
  const xl = xr.join(' ')
  const yl = yr.join(' ')
  return !xl || !yl || xl.startsWith(yl) || yl.startsWith(xl)
}

/** Deterministic 32-bit FNV-1a hash. */
export function hash32(s: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** "Couldn't reach LinkedIn (ERR_NAME_NOT_RESOLVED)…" for browser network errors, else null. */
export function networkError(e: unknown) {
  const m = /net::(ERR_[A-Z_]+)/.exec(errorMessage(e))
  if (!m || m[1] === 'ERR_ABORTED') return null
  return `Couldn't reach LinkedIn (${m[1]}). Check the server's internet connection and try again.`
}

/** The browser, its context or the page is gone (crashed, closed, disconnected): not the lead's fault. */
export function browserGone(e: unknown) {
  return /target (page, context or browser )?(has been )?closed|target crashed|page crashed|browser has been closed|browser (has )?disconnected|browser closed|context (has been )?closed|connection closed/i.test(
    errorMessage(e),
  )
}

/** The account's LinkedIn interface is not English: every page reader here relies on English labels. */
export const NON_ENGLISH_MESSAGE =
  "LinkedIn is shown in a language other than English, which this app can't read. Switch LinkedIn's language to English (LinkedIn → Settings & Privacy → Account preferences → Language), then click Test in Settings."

/** `<html lang>` of a LinkedIn page ("en", "en-US", "de-de"…): false only for a known non-English language. */
export function isEnglishUi(lang: string | null | undefined) {
  const l = (lang ?? '').trim()
  return !l || /^en([-_]|$)/i.test(l)
}
