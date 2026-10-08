import { isIP } from 'node:net'

/**
 * Sliding-window failure counter with bounded memory: each key keeps at most `max` timestamps,
 * expired keys are pruned as new failures arrive, and beyond `maxKeys` the least recently
 * failed keys are evicted.
 */
export interface FailureWindow {
  /** ms until another attempt is allowed, 0 when not blocked */
  blockedFor(key: string): number
  fail(key: string): void
  /** takes back the most recent failure of `key` */
  forgetOne(key: string): void
  clear(key: string): void
  /** number of keys currently held (for tests) */
  readonly size: number
}

export function createFailureWindow(opts: { max: number; windowMs: number; maxKeys: number; now: () => number }): FailureWindow {
  const { max, windowMs, maxKeys, now } = opts
  // Map order = order of the latest failure per key (re-inserted on every failure), oldest first.
  const failures = new Map<string, number[]>()

  /** Recent failure times for `key`, oldest first; drops the key when all have expired. */
  function recent(key: string, t: number) {
    const list = failures.get(key)
    if (!list) return []
    const fresh = list.filter((x) => t - x < windowMs)
    if (fresh.length) failures.set(key, fresh)
    else failures.delete(key)
    return fresh
  }

  /** Drop keys whose newest failure is outside the window (they sit at the front of the map). */
  function prune(t: number) {
    for (const [key, list] of failures) {
      if (t - list[list.length - 1] < windowMs) break
      failures.delete(key)
    }
  }

  return {
    blockedFor(key) {
      const t = now()
      const list = recent(key, t)
      return list.length >= max ? list[list.length - max] + windowMs - t : 0
    },
    fail(key) {
      const t = now()
      prune(t)
      const list = recent(key, t)
      list.push(t)
      if (list.length > max) list.splice(0, list.length - max) // only the last `max` matter
      failures.delete(key) // re-insert so map order tracks recency
      failures.set(key, list)
      while (failures.size > maxKeys) failures.delete(failures.keys().next().value as string)
    },
    forgetOne(key) {
      const list = failures.get(key)
      if (!list) return
      list.pop()
      if (!list.length) failures.delete(key)
    },
    clear(key) {
      failures.delete(key)
    },
    get size() {
      return failures.size
    },
  }
}

/** The 8 groups of a valid IPv6 address (zone id stripped), as numbers. */
function ipv6Groups(addr: string): number[] {
  let s = addr.split('%')[0]
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s)
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number)
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, tail] = s.split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const groups = tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t]
  return groups.map((g) => parseInt(g, 16))
}

/**
 * The rate-limit bucket of a client address: IPv4 as is (also when IPv4-mapped), IPv6 by its /64
 * prefix (one host usually owns a whole /64), anything that is not an IP address → "unknown".
 */
export function ipBucket(ip: string | undefined): string {
  if (!ip) return 'unknown'
  const kind = isIP(ip)
  if (kind === 4) return ip
  if (kind !== 6) return 'unknown'
  const g = ipv6Groups(ip)
  const mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff
  if (mapped) return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.')
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(':')}::/64`
}

/**
 * In-memory limiter for failed logins. Failures are counted per (email + client IP), and two
 * looser caps stop wider attacks: per client IP across all emails (password spraying) and per
 * email across all IPs (a distributed attack on one account). A successful login remembers the
 * (email, IP) pair for a while; the two wide caps don't apply to a remembered pair, so an attacker
 * hammering an account from many addresses does not lock its owner out of a device they used before.
 */
export interface LoginLimiter {
  /** ms until another attempt is allowed, 0 when not blocked */
  blockedFor(email: string, ip: string): number
  /**
   * Counts a failed attempt. Call it before the (slow) password check, so that concurrent requests
   * can't all pass `blockedFor`, and call `reset` when the password turns out to be right.
   */
  fail(email: string, ip: string): void
  /**
   * The attempt counted by `fail` succeeded: takes it back from the wide caps, clears the
   * (email, IP) failures and remembers the pair.
   */
  reset(email: string, ip: string): void
}

export interface LoginLimiterOptions {
  /** failures per (email, IP) */
  maxPerPair?: number
  /** failures per IP across all emails */
  maxPerIp?: number
  /** failures per email across all IPs */
  maxPerEmail?: number
  windowMs?: number
  /** how long a successful (email, IP) pair stays exempt from the wide caps */
  trustMs?: number
  /** keys kept per counter before the least recent are evicted */
  maxKeys?: number
  now?: () => number
}

export function createLoginLimiter(opts: LoginLimiterOptions = {}): LoginLimiter {
  const windowMs = opts.windowMs ?? 15 * 60_000
  const trustMs = opts.trustMs ?? 30 * 86_400_000
  const maxKeys = opts.maxKeys ?? 50_000
  const now = opts.now ?? Date.now
  const pairs = createFailureWindow({ max: opts.maxPerPair ?? 10, windowMs, maxKeys, now })
  const ips = createFailureWindow({ max: opts.maxPerIp ?? 100, windowMs, maxKeys, now })
  const emails = createFailureWindow({ max: opts.maxPerEmail ?? 100, windowMs, maxKeys, now })
  // (email, IP) pairs that signed in successfully → time of that sign-in; insertion order = age
  const trusted = new Map<string, number>()

  const norm = (email: string) => email.trim().toLowerCase()
  const pairKey = (email: string, ip: string) => `${norm(email)}|${ip}`

  function isTrusted(key: string, t: number) {
    for (const [k, at] of trusted) {
      if (t - at < trustMs) break
      trusted.delete(k)
    }
    const at = trusted.get(key)
    return at !== undefined && t - at < trustMs
  }

  return {
    blockedFor(email, ip) {
      const key = pairKey(email, ip)
      const own = pairs.blockedFor(key)
      if (isTrusted(key, now())) return own
      return Math.max(own, ips.blockedFor(ip), emails.blockedFor(norm(email)))
    },
    fail(email, ip) {
      pairs.fail(pairKey(email, ip))
      ips.fail(ip)
      emails.fail(norm(email))
    },
    reset(email, ip) {
      const key = pairKey(email, ip)
      pairs.clear(key)
      ips.forgetOne(ip)
      emails.forgetOne(norm(email))
      trusted.delete(key)
      trusted.set(key, now())
      while (trusted.size > maxKeys) trusted.delete(trusted.keys().next().value as string)
    },
  }
}
