/**
 * The automation engine (docs/ENGINE.md). Every tick it looks at each user with a connected LinkedIn
 * account and an active campaign, and — inside their active hours and after the random gap since
 * their last action — performs one unit of LinkedIn work: a page of a search import, or the current
 * step of the most overdue lead. All state lives in SQLite, so a restart resumes where it left off.
 */
import type { UserSettings } from '../../../shared/types.ts'
import { isWithinActiveHours, nextActiveTime, startOfDayInZone } from '../../../shared/time.ts'
import { type DB, all, one, run } from '../db/index.ts'
import type { LinkedInDriver, LinkedInService } from '../linkedin/types.ts'
import { type EngineCtx, logText, tag } from './context.ts'
import { type ImportUnit, applyImportFailure, applyImportPage, fetchImportPage } from './imports.ts'
import { reconcileLeads } from './reconcile.ts'
import { DAILY_LIMITS, MAX_INLINE_STEPS, gapMs, isLimited, nextDayWindow } from './schedule.ts'
import {
  LINKEDIN_STEPS,
  type LeadUnit,
  applyFailure,
  applyOutcome,
  finishLeadInline,
  performStep,
  skipLeadInline,
  skipStepInline,
  stepText,
} from './steps.ts'
import {
  type ImportRow,
  type LeadRow,
  TERMINAL_SQL,
  completeCampaigns,
  contactedElsewhere,
  countSuccess,
  leadName,
  postponeKind,
  readCampaign,
  readUserSettings,
  setAccountGap,
} from './store.ts'

export interface Engine {
  /** setInterval(tick, tickMs); never two ticks at once */
  start(): void
  stop(): void
  /** One pass over all users; resolves when the work it started (and any still running) is done. */
  tick(): Promise<void>
  /** Next time the engine may act for this user (gap / active hours), null if nothing is scheduled. */
  nextActionAt(userId: string): number | null
}

export interface EngineDeps {
  db: DB
  linkedin: LinkedInService
  tickMs: number
  now?: () => number
  rand?: () => number
  /** Log sinks (default: console). */
  log?: (msg: string) => void
  logError?: (msg: string, err?: unknown) => void
}

type Unit = LeadUnit | ImportUnit

/**
 * Only 'connected' accounts get work: 'expired' (session_expired) and 'error' (account_problem)
 * accounts wait until the user reconnects / tests the account successfully.
 */
const ELIGIBLE_USERS_SQL = `
  SELECT a.user_id, a.next_action_at FROM linkedin_accounts a
  WHERE a.status = 'connected'
    AND EXISTS (SELECT 1 FROM campaigns c WHERE c.user_id = a.user_id AND c.status = 'active')
  ORDER BY a.user_id`

const OPEN_IMPORT_SQL = `
  SELECT i.* FROM lead_imports i JOIN campaigns c ON c.id = i.campaign_id
  WHERE i.user_id = ? AND i.status IN ('pending', 'running') AND c.status = 'active'
  ORDER BY i.created_at, i.rowid LIMIT 1`

const DUE_LEAD_SQL = `
  SELECT l.* FROM leads l JOIN campaigns c ON c.id = l.campaign_id
  WHERE l.user_id = ? AND c.status = 'active' AND l.next_action_at IS NOT NULL AND l.next_action_at <= ?
    AND l.status NOT IN ${TERMINAL_SQL}
  ORDER BY l.next_action_at, l.rowid LIMIT 1`

const NEXT_LEAD_SQL = `
  SELECT MIN(l.next_action_at) AS t FROM leads l JOIN campaigns c ON c.id = l.campaign_id
  WHERE l.user_id = ? AND c.status = 'active' AND l.next_action_at IS NOT NULL AND l.status NOT IN ${TERMINAL_SQL}`

/** Guard against a busy loop from a mis-set ENGINE_TICK_MS. */
const MIN_TICK_MS = 100

type CallResult<T> = { ok: true; value: T } | { ok: false; error: unknown }

export function createEngine(deps: EngineDeps): Engine {
  const { db, linkedin } = deps
  const now = deps.now ?? Date.now
  const rand = deps.rand ?? Math.random
  /** `${userId}:${kind}` → until (LinkedIn rate-limited that kind of action; in memory only). */
  const throttles = new Map<string, number>()
  /** Users with a LinkedIn unit in progress (at most one each). */
  const inFlight = new Map<string, Promise<void>>()
  let timer: ReturnType<typeof setInterval> | null = null
  let ticking: Promise<void> | null = null
  let stopped = false

  const ctx: EngineCtx = {
    db,
    now,
    rand,
    log: deps.log ?? ((msg) => console.log(msg)),
    logError: deps.logError ?? ((msg, err) => console.error(msg, err)),
    throttle(userId, kind, until) {
      const key = `${userId}:${kind}`
      throttles.set(key, Math.max(throttles.get(key) ?? 0, until))
    },
  }

  function throttledUntil(userId: string, kind: string, at: number): number | null {
    const key = `${userId}:${kind}`
    const until = throttles.get(key)
    if (until === undefined) return null
    if (until > at) return until
    throttles.delete(key)
    return null
  }

  /** Postpone the due leads at steps of the lead's kind (one campaign, or all when `campaignId` is omitted). */
  function postpone(lead: LeadRow, kind: LeadUnit['step']['kind'], until: number, at: number, campaignId?: string) {
    let n = postponeKind(db, lead.user_id, kind, until, at, campaignId)
    if (!n) n = Number(run(db, 'UPDATE leads SET next_action_at = ? WHERE id = ?', until, lead.id).changes)
    return n
  }

  /**
   * The next LinkedIn unit for a user, or null. Steps that need no LinkedIn call (end, a missing step)
   * and leads held back by daily limits are dealt with here, then the search continues (bounded).
   */
  function pickUnit(userId: string, at: number, settings: UserSettings): Unit | null {
    if (!throttledUntil(userId, 'search', at)) {
      const imp = one<ImportRow>(db, OPEN_IMPORT_SQL, userId)
      const campaign = imp && readCampaign(db, imp.campaign_id)
      if (imp && campaign) return { type: 'import', userId, imp, campaign }
    }
    for (let i = 0; i < MAX_INLINE_STEPS; i++) {
      const lead = one<LeadRow>(db, DUE_LEAD_SQL, userId, at)
      if (!lead) return null
      const campaign = readCampaign(db, lead.campaign_id)
      if (!campaign) return null
      const step = lead.current_step_id ? campaign.sequence.steps[lead.current_step_id] : undefined
      if (!step || typeof step !== 'object') {
        reconcileLeads(db, campaign.id, campaign.sequence, at, rand)
        ctx.log(`${tag(userId)} step missing → lead re-scheduled from the sequence (${leadName(lead) || lead.id})`)
        continue
      }
      const unit: LeadUnit = { type: 'lead', userId, lead, campaign, step, text: stepText(step, lead) }
      if (step.kind === 'end') {
        finishLeadInline(ctx, lead)
        continue
      }
      if (!LINKEDIN_STEPS.includes(step.kind)) {
        skipStepInline(ctx, unit, null)
        continue
      }
      // skipOtherCampaigns, again right before the first LinkedIn action: the same person may have
      // been added while the other campaign was a draft or paused, or both started at once.
      if (campaign.settings.skipOtherCampaigns && lead.last_action_at == null) {
        const other = contactedElsewhere(db, lead)
        if (other !== null) {
          skipLeadInline(ctx, unit, `Already being contacted by campaign “${other}”`)
          continue
        }
      }

      const throttled = throttledUntil(userId, step.kind, at)
      if (throttled) {
        const n = postpone(lead, step.kind, throttled, at)
        ctx.log(`${tag(userId)} ${step.kind} rate-limited by LinkedIn – ${n} lead(s) postponed to ${new Date(throttled).toISOString()}`)
        continue
      }
      if (isLimited(step.kind)) {
        const { setting, cap } = DAILY_LIMITS[step.kind]
        const since = startOfDayInZone(new Date(at), settings.timezone).getTime()
        const accountFull = countSuccess(db, { userId }, step.kind, since) >= cap
        if (accountFull || countSuccess(db, { campaignId: campaign.id }, step.kind, since) >= campaign.settings[setting]) {
          const until = nextDayWindow(at, settings)
          const n = postpone(lead, step.kind, until, at, accountFull ? undefined : campaign.id)
          const which = accountFull ? `account cap of ${cap}` : `daily limit of campaign "${campaign.name}"`
          ctx.log(`${tag(userId)} ${step.kind}: ${which} reached – ${n} lead(s) postponed to ${new Date(until).toISOString()}`)
          continue
        }
      }
      if (step.kind === 'message' && !unit.text) {
        skipStepInline(ctx, unit, 'Message is empty after personalisation')
        continue
      }
      return unit
    }
    return null
  }

  /** Run `fn` on LinkedIn, then start the user's random gap (after success and failure alike). */
  async function onLinkedIn<T>(userId: string, fn: (d: LinkedInDriver) => Promise<T>): Promise<CallResult<T>> {
    let out: CallResult<T>
    try {
      out = { ok: true, value: await linkedin.withDriver(userId, fn) }
    } catch (error) {
      out = { ok: false, error }
    }
    setAccountGap(db, userId, now() + gapMs(readUserSettings(db, userId), rand))
    return out
  }

  /** A failure caused by stop() (browser closing on shutdown) must not count against the lead. */
  function interrupted(userId: string, error: unknown) {
    if (!stopped) return false
    ctx.log(`${tag(userId)} unit interrupted by shutdown: ${logText(error)}`)
    return true
  }

  async function execute(unit: Unit) {
    if (unit.type === 'import') {
      const r = await onLinkedIn(unit.userId, (d) => fetchImportPage(d, unit))
      guard(unit, () => {
        if (r.ok) applyImportPage(ctx, unit, r.value)
        else if (!interrupted(unit.userId, r.error)) applyImportFailure(ctx, unit, r.error)
      })
    } else {
      const r = await onLinkedIn(unit.userId, (d) => performStep(d, unit))
      guard(unit, () => {
        if (r.ok) applyOutcome(ctx, unit, r.value)
        else if (!interrupted(unit.userId, r.error)) applyFailure(ctx, unit, r.error)
      })
    }
  }

  /**
   * If saving a result fails unexpectedly, stop the lead / import instead of leaving it due:
   * otherwise the same LinkedIn action (e.g. a message) would be repeated after every gap.
   */
  function guard(unit: Unit, write: () => void) {
    try {
      write()
    } catch (e) {
      ctx.logError(`${tag(unit.userId)} could not save the result of a ${unit.type === 'import' ? 'search import' : unit.step.kind} unit`, e)
      const error = 'Internal error while saving the result – check the server logs'
      try {
        if (unit.type === 'import')
          run(db, `UPDATE lead_imports SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`, error, now(), unit.imp.id)
        else run(db, `UPDATE leads SET status = 'failed', error = ?, next_action_at = NULL WHERE id = ?`, error, unit.lead.id)
      } catch (e2) {
        ctx.logError(`${tag(unit.userId)} could not mark the unit failed`, e2)
      }
    }
  }

  function complete(userId: string, at: number) {
    try {
      for (const name of completeCampaigns(db, userId, at)) ctx.log(`${tag(userId)} campaign "${name}" completed`)
    } catch (e) {
      ctx.logError(`${tag(userId)} campaign completion check failed`, e)
    }
  }

  /** Look at one user; returns the started unit, if any. Never throws. */
  function visit(userId: string, gapUntil: number | null): Promise<void> | null {
    const at = now()
    let unit: Unit | null = null
    try {
      const settings = readUserSettings(db, userId)
      if (isWithinActiveHours(new Date(at), settings) && !(gapUntil != null && gapUntil > at)) unit = pickUnit(userId, at, settings)
    } catch (e) {
      ctx.logError(`${tag(userId)} failed to pick work`, e)
    }
    if (!unit) {
      complete(userId, at)
      return null
    }
    const p = execute(unit)
      .catch((e) => ctx.logError(`${tag(userId)} unit failed unexpectedly`, e))
      .finally(() => {
        inFlight.delete(userId)
        complete(userId, now())
      })
    inFlight.set(userId, p)
    return p
  }

  /** One synchronous pass: starts at most one unit per user that has none running. */
  function pass() {
    let users: { user_id: string; next_action_at: number | null }[]
    try {
      users = all(db, ELIGIBLE_USERS_SQL)
    } catch (e) {
      ctx.logError('[engine] tick failed', e)
      return
    }
    for (const u of users) if (!inFlight.has(u.user_id)) visit(u.user_id, u.next_action_at)
  }

  return {
    start() {
      if (timer) return
      stopped = false
      const every = Math.max(MIN_TICK_MS, deps.tickMs || 0)
      timer = setInterval(() => {
        try {
          if (!ticking) pass()
        } catch (e) {
          ctx.logError('[engine] pass failed', e)
        }
      }, every)
      timer.unref?.()
      ctx.log(`[engine] started (tick every ${every / 1000}s)`)
    },

    stop() {
      if (timer) clearInterval(timer)
      timer = null
      stopped = true
    },

    tick() {
      if (ticking) return ticking
      stopped = false
      ticking = (async () => {
        pass()
        await Promise.allSettled([...inFlight.values()])
      })().finally(() => {
        ticking = null
      })
      return ticking
    },

    nextActionAt(userId) {
      try {
        const at = now()
        const acc = one<{ status: string; next_action_at: number | null }>(
          db,
          'SELECT status, next_action_at FROM linkedin_accounts WHERE user_id = ?',
          userId,
        )
        if (!acc || acc.status !== 'connected') return null
        const candidates: number[] = []
        const lead = one<{ t: number | null }>(db, NEXT_LEAD_SQL, userId)
        if (lead?.t != null) candidates.push(lead.t)
        if (one(db, OPEN_IMPORT_SQL, userId)) candidates.push(throttledUntil(userId, 'search', at) ?? at)
        if (!candidates.length) return null
        // due work waits for the gap; future work for its own time (and the gap, if that ends later)
        const t = Math.max(Math.min(...candidates), at, acc.next_action_at ?? 0)
        return nextActiveTime(new Date(t), readUserSettings(db, userId))?.getTime() ?? null
      } catch (e) {
        ctx.logError(`${tag(userId)} nextActionAt failed`, e)
        return null
      }
    },
  }
}
