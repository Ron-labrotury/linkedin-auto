/**
 * Pure helpers for the active-hours UI (covered by schedule.test.ts).
 * shared/time.ts is imported by relative path (not @shared) so `node --test` can run this file as is.
 */
import type { UserSettings } from '@shared/types.ts'
import { isWithinActiveHours, nextActiveTime, parseHHMM, validateUserSettings } from '../../../../shared/time.ts'

/** Display order Monday first; `day` uses the API's 0 = Sunday … 6 = Saturday. */
export const WEEKDAYS = [
  { day: 1, short: 'Mon', long: 'Monday' },
  { day: 2, short: 'Tue', long: 'Tuesday' },
  { day: 3, short: 'Wed', long: 'Wednesday' },
  { day: 4, short: 'Thu', long: 'Thursday' },
  { day: 5, short: 'Fri', long: 'Friday' },
  { day: 6, short: 'Sat', long: 'Saturday' },
  { day: 0, short: 'Sun', long: 'Sunday' },
]

const FALLBACK_ZONES = [
  'UTC',
  'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Lagos', 'Africa/Nairobi',
  'America/Anchorage', 'America/Bogota', 'America/Chicago', 'America/Denver', 'America/Halifax', 'America/Los_Angeles',
  'America/Mexico_City', 'America/New_York', 'America/Phoenix', 'America/Sao_Paulo', 'America/Toronto', 'America/Vancouver',
  'Asia/Bangkok', 'Asia/Dhaka', 'Asia/Dubai', 'Asia/Ho_Chi_Minh', 'Asia/Hong_Kong', 'Asia/Jakarta', 'Asia/Jerusalem', 'Asia/Karachi', 'Asia/Kathmandu',
  'Asia/Kolkata', 'Asia/Manila', 'Asia/Riyadh', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Tokyo',
  'Atlantic/Reykjavik', 'Australia/Adelaide', 'Australia/Brisbane', 'Australia/Melbourne', 'Australia/Perth', 'Australia/Sydney',
  'Europe/Amsterdam', 'Europe/Athens', 'Europe/Berlin', 'Europe/Dublin', 'Europe/Istanbul', 'Europe/Lisbon', 'Europe/London',
  'Europe/Kyiv', 'Europe/Madrid', 'Europe/Moscow', 'Europe/Paris', 'Europe/Rome', 'Europe/Stockholm', 'Europe/Warsaw', 'Europe/Zurich',
  'Pacific/Auckland', 'Pacific/Honolulu',
]

export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}

function offsetLabel(tz: string, at: Date) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')
    return part?.value ?? ''
  } catch {
    return ''
  }
}

/** Every IANA zone the browser knows (or a fallback list), always including `extra` (e.g. the saved zone), sorted by name. */
export function timeZoneOptions(at: Date, extra: (string | null | undefined)[] = []): { value: string; label: string }[] {
  let zones: string[]
  try {
    zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : FALLBACK_ZONES
  } catch {
    zones = FALLBACK_ZONES
  }
  // ICU lists some zones by legacy names (Asia/Calcutta), so also offer the common modern ones (Asia/Kolkata)
  const set = new Set([...zones, ...FALLBACK_ZONES])
  for (const tz of extra) if (tz) set.add(tz)
  return [...set]
    .sort((a, b) => a.localeCompare(b))
    .map((tz) => {
      const offset = offsetLabel(tz, at)
      return { value: tz, label: `${tz.replace(/_/g, ' ')}${offset ? ` (${offset})` : ''}` }
    })
}

/** "Mon 09:00" (weekday + 24h time) of `date` in `tz`. */
export function formatWeekdayTime(date: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('weekday')} ${get('hour')}:${get('minute')}`
}

/** "in 5 min", "in 3 h 20 min", "in 2 days". */
export function formatIn(ms: number) {
  const mins = Math.max(1, Math.round(ms / 60_000))
  if (mins < 60) return `in ${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h < 48) return m ? `in ${h} h ${m} min` : `in ${h} h`
  return `in ${Math.round(h / 24)} days`
}

/** "Mon–Fri", "Every day", "Weekends", "Mon, Wed, Fri" … */
export function describeDays(days: number[]) {
  const set = new Set(days)
  if (set.size === 7) return 'Every day'
  if (!set.size) return 'No days'
  if (set.size === 2 && set.has(0) && set.has(6)) return 'Weekends'
  const ordered = WEEKDAYS.filter((d) => set.has(d.day))
  // a contiguous run (Monday-first) of 3+ days reads better as a range
  const idx = ordered.map((d) => WEEKDAYS.indexOf(d))
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1)
  if (contiguous && ordered.length >= 3) return `${ordered[0].short}–${ordered[ordered.length - 1].short}`
  return ordered.map((d) => d.short).join(', ')
}

export type ScheduleStatus =
  | { state: 'invalid' }
  | { state: 'active'; until: string }
  | { state: 'waiting'; nextAt: Date; label: string; relative: string }
  | { state: 'never' }

/** Whether LinkedIn actions may run at `now`, and when the next window starts — same math as the engine. */
export function scheduleStatus(now: Date, s: UserSettings): ScheduleStatus {
  if (Object.keys(validateUserSettings(s)).length) return { state: 'invalid' }
  if (isWithinActiveHours(now, s)) return { state: 'active', until: s.activeEnd }
  const next = nextActiveTime(now, s)
  if (!next) return { state: 'never' }
  return { state: 'waiting', nextAt: next, label: formatWeekdayTime(next, s.timezone), relative: formatIn(next.getTime() - now.getTime()) }
}

/** Length of the daily window, e.g. "9 h" or "7 h 30 min" (null when invalid). */
export function windowLength(start: string, end: string) {
  const a = parseHHMM(start)
  const b = parseHHMM(end)
  if (a === null || b === null || b <= a) return null
  const mins = b - a
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`
}

export const sameSettings = (a: UserSettings, b: UserSettings) =>
  a.timezone === b.timezone &&
  a.activeStart === b.activeStart &&
  a.activeEnd === b.activeEnd &&
  a.gapMinMinutes === b.gapMinMinutes &&
  a.gapMaxMinutes === b.gapMaxMinutes &&
  [...a.activeDays].sort().join() === [...b.activeDays].sort().join()
