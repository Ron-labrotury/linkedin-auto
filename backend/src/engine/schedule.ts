/** Timing rules of the engine (docs/ENGINE.md). Pure functions; `rand` returns [0, 1). */
import type { StepKind, UserSettings } from '../../../shared/types.ts'
import { nextActiveTime, zonedParts, zonedTimeToUtc } from '../../../shared/time.ts'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** Failed attempts of one step before the lead is marked failed. */
export const MAX_ATTEMPTS = 3
/** Steps that do not touch LinkedIn resolved per lookup before giving up until the next tick. */
export const MAX_INLINE_STEPS = 25
/** Search imports stop after this many result pages. */
export const MAX_IMPORT_PAGES = 100

/** Steps with a per-campaign daily limit, the campaign setting that holds it, and the account-wide cap. */
export const DAILY_LIMITS = {
  invite: { setting: 'dailyInvites', cap: 100 },
  message: { setting: 'dailyMessages', cap: 150 },
  view_profile: { setting: 'dailyProfileViews', cap: 250 },
} as const satisfies Partial<Record<StepKind, { setting: string; cap: number }>>

export type LimitedKind = keyof typeof DAILY_LIMITS
export const isLimited = (k: StepKind): k is LimitedKind => k in DAILY_LIMITS

/** The random pause after a LinkedIn action: gapMin–gapMax minutes, whole seconds. */
export function gapMs(s: Pick<UserSettings, 'gapMinMinutes' | 'gapMaxMinutes'>, rand: () => number) {
  const lo = Math.max(0, s.gapMinMinutes)
  const hi = Math.max(lo, s.gapMaxMinutes)
  return Math.round((lo + rand() * (hi - lo)) * 60) * 1000
}

/** Start of the first active window on or after the user's next local midnight. */
export function nextDayWindow(now: number, s: UserSettings) {
  const p = zonedParts(new Date(now), s.timezone)
  const midnight = zonedTimeToUtc(p.year, p.month, p.day + 1, 0, 0, s.timezone)
  return (nextActiveTime(midnight, s) ?? midnight).getTime()
}

/** Next check of an unresolved condition: min(timeout, now + clamp(within / 6, 2 min, 4 h) ± 20 %). */
export function recheckAt(now: number, startedAt: number, withinMs: number, rand: () => number) {
  const base = Math.min(Math.max(withinMs / 6, 2 * MINUTE), 4 * HOUR)
  const jittered = Math.round(base * (0.8 + rand() * 0.4))
  return Math.min(startedAt + withinMs, now + jittered)
}

/** Retry after a failure: attempts × random(15, 30) minutes. */
export const retryAt = (now: number, attempts: number, rand: () => number) => now + Math.round(attempts * (15 + rand() * 15) * MINUTE)

/** Back-off of the whole user after a 'transient' failure (network / browser trouble): random 10–20 minutes. */
export const transientBackoffAt = (now: number, rand: () => number) => now + Math.round((10 + rand() * 10) * MINUTE)
