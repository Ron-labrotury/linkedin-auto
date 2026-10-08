/**
 * Active-hours math in the user's IANA time zone, using only Intl (no deps).
 * Shared so the UI can show the same "next run" the engine computes.
 */
import type { UserSettings } from './types.ts'

export const DEFAULT_SETTINGS: UserSettings = {
  timezone: 'Asia/Kolkata',
  activeDays: [1, 2, 3, 4, 5],
  activeStart: '09:00',
  activeEnd: '18:00',
  gapMinMinutes: 1,
  gapMaxMinutes: 5,
}

export const MAX_GAP_MINUTES = 120

interface ZonedParts {
  year: number
  month: number // 1-12
  day: number
  hour: number
  minute: number
  weekday: number // 0 = Sunday
}

// Keyed by canonical zone name and bounded, so arbitrary user input (e.g. case variants of a
// zone name) can't grow it without limit.
const fmtCache = new Map<string, Intl.DateTimeFormat>()
const FMT_CACHE_MAX = 600

/** The canonical IANA name ("asia/KOLKATA" → "Asia/Kolkata"); throws RangeError for unknown zones. */
export function canonicalTimeZone(tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone
}

function formatter(tz: string) {
  let f = fmtCache.get(tz)
  if (!f) {
    const canonical = canonicalTimeZone(tz)
    f = fmtCache.get(canonical)
    if (f) return f
    if (fmtCache.size >= FMT_CACHE_MAX) fmtCache.clear()
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    })
    fmtCache.set(canonical, f)
  }
  return f
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function isValidTimeZone(tz: string) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false
  try {
    canonicalTimeZone(tz)
    return true
  } catch {
    return false
  }
}

export function zonedParts(date: Date, tz: string): ZonedParts {
  const parts = Object.fromEntries(formatter(tz).formatToParts(date).map((p) => [p.type, p.value]))
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday),
  }
}

/** Offset (ms) of `tz` from UTC at instant `ms`. */
function tzOffset(ms: number, tz: string) {
  const p = zonedParts(new Date(ms), tz)
  const sec = new Date(ms).getUTCSeconds()
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, sec)
  return asUtc - (ms - (ms % 1000))
}

/** The UTC instant of local wall time y-m-d h:mi in `tz` (DST-aware; a time inside a DST gap maps to an adjacent valid instant). */
export function zonedTimeToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi)
  let ms = guess - tzOffset(guess, tz)
  const second = guess - tzOffset(ms, tz)
  if (second !== ms) ms = second
  return new Date(ms)
}

export function parseHHMM(s: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

export function isWithinActiveHours(date: Date, s: UserSettings) {
  const p = zonedParts(date, s.timezone)
  const start = parseHHMM(s.activeStart) ?? 0
  const end = parseHHMM(s.activeEnd) ?? 0
  const mins = p.hour * 60 + p.minute
  return s.activeDays.includes(p.weekday) && mins >= start && mins < end
}

/** `date` itself if it is inside active hours, otherwise the start of the next active window. */
export function nextActiveTime(date: Date, s: UserSettings): Date | null {
  if (!s.activeDays.length) return null
  if (isWithinActiveHours(date, s)) return date
  const start = parseHHMM(s.activeStart) ?? 0
  const p = zonedParts(date, s.timezone)
  for (let i = 0; i <= 8; i++) {
    // walk calendar days in the zone; use noon UTC of that local date to step safely
    const probe = new Date(Date.UTC(p.year, p.month - 1, p.day + i, 12))
    const y = probe.getUTCFullYear()
    const mo = probe.getUTCMonth() + 1
    const d = probe.getUTCDate()
    const candidate = zonedTimeToUtc(y, mo, d, Math.floor(start / 60), start % 60, s.timezone)
    if (candidate.getTime() > date.getTime() && isWithinActiveHours(candidate, s)) return candidate
  }
  return null
}

/** UTC instant of local midnight (start of "today") in `tz`. Used for daily limits. */
export function startOfDayInZone(date: Date, tz: string): Date {
  const p = zonedParts(date, tz)
  return zonedTimeToUtc(p.year, p.month, p.day, 0, 0, tz)
}

/** Returns an error message per invalid field, or {} when valid. */
export function validateUserSettings(s: UserSettings): Record<string, string> {
  const errors: Record<string, string> = {}
  if (typeof s.timezone !== 'string' || !isValidTimeZone(s.timezone)) errors.timezone = 'Unknown time zone'
  if (!Array.isArray(s.activeDays) || !s.activeDays.length || s.activeDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6))
    errors.activeDays = 'Pick at least one day'
  const a = parseHHMM(s.activeStart)
  const b = parseHHMM(s.activeEnd)
  if (a === null) errors.activeStart = 'Use HH:MM'
  if (b === null) errors.activeEnd = 'Use HH:MM'
  if (a !== null && b !== null && b <= a) errors.activeEnd = 'End must be after start'
  if (!Number.isFinite(s.gapMinMinutes) || s.gapMinMinutes < 0) errors.gapMinMinutes = 'Must be 0 or more'
  if (!Number.isFinite(s.gapMaxMinutes) || s.gapMaxMinutes < s.gapMinMinutes || s.gapMaxMinutes > MAX_GAP_MINUTES)
    errors.gapMaxMinutes = `Must be between the minimum and ${MAX_GAP_MINUTES}`
  return errors
}
