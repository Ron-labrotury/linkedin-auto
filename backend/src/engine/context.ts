import type { StepKind } from '../../../shared/types.ts'
import type { DB } from '../db/index.ts'
import { LinkedInError, type LinkedInErrorCode } from '../linkedin/types.ts'
import { transientBackoffAt } from './schedule.ts'
import { addActivity, backOffAccount, expireAccount, markAccountError } from './store.ts'

/** What the unit handlers need from the engine. */
export interface EngineCtx {
  db: DB
  now: () => number
  rand: () => number
  log: (msg: string) => void
  logError: (msg: string, err?: unknown) => void
  /** Hold back steps of `kind` ("search" for imports) for the user until `until` (LinkedIn throttled us). */
  throttle: (userId: string, kind: StepKind | 'search', until: number) => void
}

export const errorCode = (e: unknown): LinkedInErrorCode => (e instanceof LinkedInError ? e.code : 'unknown')

/** Error message for the activity feed / lead error column. */
export function errorText(e: unknown) {
  const msg = (e instanceof Error ? e.message : String(e ?? '')).replace(/\s+/g, ' ').trim()
  return (msg || 'Unexpected error').slice(0, 300)
}

/** Same, safe for server logs: URLs (profile / search links) removed. */
export const logText = (e: unknown) => errorText(e).replace(/https?:\/\/\S+/g, '<url>').slice(0, 200)

/** Short user tag for log lines. */
export const tag = (userId: string) => `[engine] ${userId.slice(0, 12)}`

function sessionActivity(ctx: EngineCtx, userId: string, detail: string, now: number) {
  addActivity(ctx.db, {
    userId,
    campaignId: null,
    campaignName: null,
    leadId: null,
    leadName: null,
    stepId: null,
    type: 'session',
    status: 'failed',
    detail,
    at: now,
  })
}

/** LinkedIn rejected the session: mark the account expired and record it once. Leads are not penalised. */
export function sessionExpired(ctx: EngineCtx, userId: string, err: unknown) {
  const now = ctx.now()
  const message = errorText(err) === 'Unexpected error' ? 'LinkedIn session expired. Reconnect your account in Settings.' : errorText(err)
  if (!expireAccount(ctx.db, userId, message, now)) return
  sessionActivity(ctx, userId, message, now)
  ctx.log(`${tag(userId)} session expired – paused until the account is reconnected`)
}

/**
 * The LinkedIn account needs the user's attention ('account_problem'): account status 'error' with
 * the message, one session activity. The engine skips the user until the account is connected again;
 * the lead / import is not penalised.
 */
export function accountProblem(ctx: EngineCtx, userId: string, err: unknown) {
  const now = ctx.now()
  const message = errorText(err) === 'Unexpected error' ? 'Your LinkedIn account needs attention. Check it in Settings.' : errorText(err)
  if (!markAccountError(ctx.db, userId, message, now)) return
  sessionActivity(ctx, userId, message, now)
  ctx.log(`${tag(userId)} LinkedIn account problem – paused until the account is reconnected: ${logText(err)}`)
}

/**
 * Network / browser trouble ('transient'): not the lead's fault. Back off the whole user for a
 * random 10–20 minutes and record one session activity. Returns the time the user may act again.
 */
export function transientFailure(ctx: EngineCtx, userId: string, err: unknown) {
  const now = ctx.now()
  const until = transientBackoffAt(now, ctx.rand)
  backOffAccount(ctx.db, userId, until)
  sessionActivity(ctx, userId, errorText(err), now)
  return until
}
