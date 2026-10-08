import type { Activity, ActivityType } from '../../../shared/types.ts'
import { type DB, all } from '../db/index.ts'
import { iso } from './util.ts'

export interface ActivityRow {
  id: string
  user_id: string
  campaign_id: string | null
  campaign_name: string | null
  lead_id: string | null
  lead_name: string | null
  step_id: string | null
  type: ActivityType
  status: Activity['status']
  detail: string
  created_at: number
}

export const toActivity = (r: ActivityRow): Activity => ({
  id: r.id,
  type: r.type,
  status: r.status,
  campaignId: r.campaign_id,
  campaignName: r.campaign_name,
  leadId: r.lead_id,
  leadName: r.lead_name,
  stepId: r.step_id,
  detail: r.detail,
  createdAt: iso(r.created_at),
})

/** Newest first. */
export function listActivities(db: DB, opts: { userId: string; campaignId?: string; limit: number }): Activity[] {
  const rows = opts.campaignId
    ? all<ActivityRow>(
        db,
        'SELECT * FROM activities WHERE user_id = ? AND campaign_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
        opts.userId,
        opts.campaignId,
        opts.limit,
      )
    : all<ActivityRow>(db, 'SELECT * FROM activities WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', opts.userId, opts.limit)
  return rows.map(toActivity)
}
