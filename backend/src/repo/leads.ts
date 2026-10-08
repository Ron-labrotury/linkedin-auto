import type { Lead, LeadStatus, LeadsPage } from '../../../shared/types.ts'
import { type DB, all, one, run, toIso } from '../db/index.ts'
import { iso } from './util.ts'

export const LEAD_STATUSES = [
  'queued',
  'in_progress',
  'invited',
  'connected',
  'replied',
  'finished',
  'skipped',
  'failed',
] as const satisfies readonly LeadStatus[]

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
  created_at: number
}

export const toLead = (r: LeadRow): Lead => ({
  id: r.id,
  campaignId: r.campaign_id,
  firstName: r.first_name,
  lastName: r.last_name,
  headline: r.headline,
  company: r.company,
  location: r.location,
  profileUrl: r.profile_url,
  status: r.status,
  listName: r.list_name,
  currentStepId: r.current_step_id,
  nextActionAt: toIso(r.next_action_at),
  lastAction: r.last_action,
  lastActionAt: toIso(r.last_action_at),
  error: r.error,
  createdAt: iso(r.created_at),
})

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

export function listLeads(
  db: DB,
  campaignId: string,
  f: { status?: LeadStatus; q?: string; offset: number; limit: number },
): LeadsPage {
  const where = ['campaign_id = ?']
  const params: unknown[] = [campaignId]
  if (f.status) {
    where.push('status = ?')
    params.push(f.status)
  }
  const q = f.q?.trim()
  if (q) {
    const like = `%${likeEscape(q)}%`
    where.push(
      `(first_name LIKE ? ESCAPE '\\' OR last_name LIKE ? ESCAPE '\\' OR (first_name || ' ' || last_name) LIKE ? ESCAPE '\\'
        OR company LIKE ? ESCAPE '\\' OR headline LIKE ? ESCAPE '\\')`,
    )
    params.push(like, like, like, like, like)
  }
  const cond = where.join(' AND ')
  const total = one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM leads WHERE ${cond}`, ...params)!.n
  // rowid breaks created_at ties in insertion order (leads of one batch share created_at)
  const rows = all<LeadRow>(db, `SELECT * FROM leads WHERE ${cond} ORDER BY created_at, rowid LIMIT ? OFFSET ?`, ...params, f.limit, f.offset)
  return { leads: rows.map(toLead), total }
}

/** Deletes the given leads of one campaign; ids of other campaigns/users are ignored. */
export function deleteLeads(db: DB, userId: string, campaignId: string, ids: string[]) {
  return run(
    db,
    'DELETE FROM leads WHERE campaign_id = ? AND user_id = ? AND id IN (SELECT value FROM json_each(?))',
    campaignId,
    userId,
    JSON.stringify(ids),
  ).changes
}
