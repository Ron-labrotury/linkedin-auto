/** Engine data access: row types, parsing with safe fallbacks, and the small writes the engine makes. */
import type { Activity, ActivityType, CampaignSettings, CampaignStatus, ImportStatus, LeadStatus, Sequence, StepKind, UserSettings } from '../../../shared/types.ts'
import { DEFAULT_SETTINGS, isValidTimeZone, parseHHMM } from '../../../shared/time.ts'
import { emptySequence } from '../../../shared/sequence.ts'
import { type DB, all, one, run } from '../db/index.ts'
import { newId } from '../ids.ts'

export const TERMINAL: readonly LeadStatus[] = ['finished', 'skipped', 'failed']
export const TERMINAL_SQL = `('finished', 'skipped', 'failed')`
export const isTerminal = (s: LeadStatus) => TERMINAL.includes(s)

const RANK: Partial<Record<LeadStatus, number>> = { queued: 0, in_progress: 1, invited: 2, connected: 3, replied: 4 }

/** `current` raised to at least `target`. Never downgrades and never leaves a terminal status. */
export function raiseStatus(current: LeadStatus, target: LeadStatus): LeadStatus {
  if (isTerminal(current)) return current
  return (RANK[target] ?? 0) > (RANK[current] ?? 0) ? target : current
}

export interface LeadRow {
  id: string
  campaign_id: string
  user_id: string
  public_id: string
  profile_url: string
  first_name: string
  last_name: string
  headline: string
  company: string
  location: string
  list_name: string
  status: LeadStatus
  current_step_id: string | null
  step_started_at: number | null
  next_action_at: number | null
  attempts: number
  invited_at: number | null
  connected_at: number | null
  replied_at: number | null
  last_action: string | null
  last_action_at: number | null
  error: string | null
  /** Rendered text of the last message this campaign delivered to the lead (reply detection). */
  last_message_text: string | null
  created_at: number
}

export type LeadPatch = Partial<Omit<LeadRow, 'id' | 'campaign_id' | 'user_id' | 'public_id' | 'profile_url' | 'created_at'>>

export interface ImportRow {
  id: string
  campaign_id: string
  user_id: string
  url: string
  max_leads: number
  collected: number
  page: number
  attempts: number
  status: ImportStatus
  list_name: string
  error: string | null
  created_at: number
  updated_at: number
}

interface CampaignRow {
  id: string
  user_id: string
  name: string
  status: CampaignStatus
  sequence_json: string
  settings_json: string
}

export interface CampaignData {
  id: string
  userId: string
  name: string
  status: CampaignStatus
  sequence: Sequence
  settings: CampaignSettings
}

/** Only fills gaps in a stored blob; the API always stores complete settings. */
const FALLBACK_CAMPAIGN_SETTINGS: CampaignSettings = {
  dailyInvites: 20,
  dailyMessages: 50,
  dailyProfileViews: 50,
  skipConnected: true,
  skipOtherCampaigns: true,
  stopOnReply: true,
}

function parseJson(text: string | null | undefined): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function parseSequence(text: string): Sequence {
  const s = parseJson(text) as Sequence | undefined
  if (!s || typeof s !== 'object' || !s.steps || typeof s.steps !== 'object') return emptySequence()
  return { rootId: typeof s.rootId === 'string' ? s.rootId : null, steps: s.steps }
}

function parseCampaignSettings(text: string): CampaignSettings {
  const raw = parseJson(text)
  const s = raw && typeof raw === 'object' ? (raw as Partial<CampaignSettings>) : {}
  const out = { ...FALLBACK_CAMPAIGN_SETTINGS }
  for (const k of ['dailyInvites', 'dailyMessages', 'dailyProfileViews'] as const) if (Number.isFinite(s[k])) out[k] = Math.max(0, s[k]!)
  for (const k of ['skipConnected', 'skipOtherCampaigns', 'stopOnReply'] as const) if (typeof s[k] === 'boolean') out[k] = s[k]!
  return out
}

export function readCampaign(db: DB, id: string): CampaignData | undefined {
  const r = one<CampaignRow>(db, 'SELECT id, user_id, name, status, sequence_json, settings_json FROM campaigns WHERE id = ?', id)
  if (!r) return undefined
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    status: r.status,
    sequence: parseSequence(r.sequence_json),
    settings: parseCampaignSettings(r.settings_json),
  }
}

export const activeCampaignIds = (db: DB, userId: string) =>
  all<{ id: string }>(db, `SELECT id FROM campaigns WHERE user_id = ? AND status = 'active' ORDER BY created_at, rowid`, userId).map((r) => r.id)

export const readLead = (db: DB, id: string) => one<LeadRow>(db, 'SELECT * FROM leads WHERE id = ?', id)

export const readImport = (db: DB, id: string) => one<ImportRow>(db, 'SELECT * FROM lead_imports WHERE id = ?', id)

export const leadName = (l: Pick<LeadRow, 'first_name' | 'last_name'>) => `${l.first_name} ${l.last_name}`.replace(/\s+/g, ' ').trim()

/** Update the given columns of a lead (keys come from LeadPatch, never from user input). */
export function updateLead(db: DB, id: string, patch: LeadPatch) {
  const keys = Object.keys(patch).filter((k) => patch[k as keyof LeadPatch] !== undefined) as (keyof LeadPatch)[]
  if (!keys.length) return
  run(db, `UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => patch[k]), id)
}

interface SettingsRow {
  timezone: string
  active_days_json: string
  active_start: string
  active_end: string
  gap_min_minutes: number
  gap_max_minutes: number
}

/** The user's active hours and gap; DEFAULT_SETTINGS when missing, field-wise defaults when corrupt. */
export function readUserSettings(db: DB, userId: string): UserSettings {
  const d = DEFAULT_SETTINGS
  const r = one<SettingsRow>(db, 'SELECT * FROM user_settings WHERE user_id = ?', userId)
  if (!r) return { ...d, activeDays: [...d.activeDays] }
  const days = parseJson(r.active_days_json)
  const activeDays = Array.isArray(days) ? days.filter((x): x is number => Number.isInteger(x) && x >= 0 && x <= 6) : [...d.activeDays]
  const gapMin = Number.isFinite(r.gap_min_minutes) && r.gap_min_minutes >= 0 ? r.gap_min_minutes : d.gapMinMinutes
  const gapMax = Number.isFinite(r.gap_max_minutes) && r.gap_max_minutes >= gapMin ? r.gap_max_minutes : Math.max(gapMin, d.gapMaxMinutes)
  return {
    timezone: isValidTimeZone(r.timezone) ? r.timezone : d.timezone,
    activeDays,
    activeStart: parseHHMM(r.active_start) !== null ? r.active_start : d.activeStart,
    activeEnd: parseHHMM(r.active_end) !== null ? r.active_end : d.activeEnd,
    gapMinMinutes: gapMin,
    gapMaxMinutes: gapMax,
  }
}

export interface ActivityInput {
  userId: string
  campaignId: string | null
  campaignName: string | null
  leadId: string | null
  leadName: string | null
  stepId: string | null
  type: ActivityType
  status: Activity['status']
  detail: string
  at: number
}

/**
 * Record an activity. Campaign / lead ids that no longer exist (deleted while an action ran) are
 * stored as NULL so the copied names survive; nothing is written if the user itself is gone.
 */
export function addActivity(db: DB, a: ActivityInput) {
  run(
    db,
    `INSERT INTO activities (id, user_id, campaign_id, campaign_name, lead_id, lead_name, step_id, type, status, detail, created_at)
     SELECT ?, u.id, (SELECT id FROM campaigns WHERE id = ?), ?, (SELECT id FROM leads WHERE id = ?), ?, ?, ?, ?, ?, ?
     FROM users u WHERE u.id = ?`,
    newId('act'),
    a.campaignId,
    a.campaignName,
    a.leadId,
    a.leadName,
    a.stepId,
    a.type,
    a.status,
    a.detail.slice(0, 500),
    a.at,
    a.userId,
  )
}

/** Successful activities of `type` since `since`, for one campaign or the whole account. */
export function countSuccess(db: DB, scope: { campaignId: string } | { userId: string }, type: ActivityType, since: number) {
  const [col, id] = 'campaignId' in scope ? ['campaign_id', scope.campaignId] : ['user_id', scope.userId]
  return one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM activities WHERE ${col} = ? AND type = ? AND status = 'success' AND created_at >= ?`,
    id,
    type,
    since,
  )!.n
}

/**
 * Move every due lead whose current step is of `kind` to `until`, in one campaign or in all of
 * the user's active campaigns. Returns the number of leads postponed.
 */
export function postponeKind(db: DB, userId: string, kind: StepKind, until: number, now: number, campaignId?: string) {
  let n = 0
  for (const id of campaignId ? [campaignId] : activeCampaignIds(db, userId)) {
    const c = readCampaign(db, id)
    if (!c) continue
    const stepIds = Object.values(c.sequence.steps)
      .filter((s) => s && s.kind === kind)
      .map((s) => s.id)
    if (!stepIds.length) continue
    n += Number(
      run(
        db,
        `UPDATE leads SET next_action_at = ?
         WHERE campaign_id = ? AND current_step_id IN (SELECT value FROM json_each(?))
           AND next_action_at IS NOT NULL AND next_action_at <= ? AND status NOT IN ${TERMINAL_SQL}`,
        until,
        id,
        JSON.stringify(stepIds),
        now,
      ).changes,
    )
  }
  return n
}

export function setAccountGap(db: DB, userId: string, at: number) {
  run(db, 'UPDATE linkedin_accounts SET next_action_at = ? WHERE user_id = ?', at, userId)
}

/**
 * Mark the account expired after LinkedIn rejected the session. An account the user disconnected
 * or is reconnecting in the meantime is left alone. Returns whether the account was (or now is) expired.
 */
export function expireAccount(db: DB, userId: string, message: string, now: number) {
  const res = run(
    db,
    `UPDATE linkedin_accounts SET status = 'expired', last_error = ?, updated_at = ?
     WHERE user_id = ? AND status IN ('connected', 'expired')`,
    message,
    now,
    userId,
  )
  return Number(res.changes) > 0
}

/**
 * Mark the account as needing the user's attention (LinkedInError 'account_problem'). The engine
 * only works for 'connected' accounts, so it stops for the user until they reconnect / test it.
 * An account the user disconnected or is reconnecting meanwhile is left alone.
 */
export function markAccountError(db: DB, userId: string, message: string, now: number) {
  const res = run(
    db,
    `UPDATE linkedin_accounts SET status = 'error', last_error = ?, updated_at = ?
     WHERE user_id = ? AND status IN ('connected', 'error')`,
    message,
    now,
    userId,
  )
  return Number(res.changes) > 0
}

/** Hold the user back until at least `until` (never shortens a later gap). */
export function backOffAccount(db: DB, userId: string, until: number) {
  run(db, 'UPDATE linkedin_accounts SET next_action_at = MAX(COALESCE(next_action_at, 0), ?) WHERE user_id = ?', until, userId)
}

/**
 * skipOtherCampaigns, checked right before the first LinkedIn action for a lead: the name of
 * another active or paused campaign of the user that is already contacting the same person
 * (a non-terminal lead there that has been acted on), or null.
 */
export function contactedElsewhere(db: DB, lead: Pick<LeadRow, 'user_id' | 'public_id' | 'campaign_id'>): string | null {
  const r = one<{ name: string }>(
    db,
    `SELECT c.name FROM leads l JOIN campaigns c ON c.id = l.campaign_id
     WHERE l.user_id = ? AND l.public_id = ? AND l.campaign_id <> ? AND c.status IN ('active', 'paused')
       AND l.status NOT IN ${TERMINAL_SQL} AND l.last_action_at IS NOT NULL
     ORDER BY l.last_action_at, l.rowid LIMIT 1`,
    lead.user_id,
    lead.public_id,
    lead.campaign_id,
  )
  return r ? r.name : null
}

/** Active campaigns with leads, no open imports and nothing scheduled → completed. Returns their names. */
export function completeCampaigns(db: DB, userId: string, now: number): string[] {
  const done = all<{ id: string; name: string }>(
    db,
    `SELECT c.id, c.name FROM campaigns c
     WHERE c.user_id = ? AND c.status = 'active'
       AND EXISTS (SELECT 1 FROM leads l WHERE l.campaign_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.campaign_id = c.id AND l.next_action_at IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM lead_imports i WHERE i.campaign_id = c.id AND i.status IN ('pending', 'running'))`,
    userId,
  )
  for (const c of done) run(db, `UPDATE campaigns SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'active'`, now, c.id)
  return done.map((c) => c.name)
}
