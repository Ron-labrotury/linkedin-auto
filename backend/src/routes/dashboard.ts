import { Router } from 'express'
import type { Dashboard } from '../../../shared/types.ts'
import { isWithinActiveHours, startOfDayInZone } from '../../../shared/time.ts'
import { all, one, toIso } from '../db/index.ts'
import type { AppDeps } from '../http/types.ts'
import { auth } from '../auth/middleware.ts'
import { type CampaignRow, campaignSettings, listCampaignRows, toCampaignSummaries } from '../repo/campaigns.ts'
import { listActivities } from '../repo/activities.ts'
import { getSettings } from '../repo/settings.ts'
import { DAILY_LIMITS } from '../engine/schedule.ts'

export function dashboardRouter({ db, linkedin, engine }: AppDeps) {
  const r = Router()

  r.get('/', (req, res) => {
    const { user } = auth(req)
    const now = new Date()
    const settings = getSettings(db, user.id)
    const since = startOfDayInZone(now, settings.timezone).getTime()

    const done = { invite: 0, message: 0, view_profile: 0 } as Record<string, number>
    for (const row of all<{ type: string; n: number }>(
      db,
      `SELECT type, COUNT(*) AS n FROM activities
       WHERE user_id = ? AND status = 'success' AND type IN ('invite', 'message', 'view_profile') AND created_at >= ?
       GROUP BY type`,
      user.id,
      since,
    ))
      done[row.type] = row.n

    const limits = { invites: 0, messages: 0, profileViews: 0 }
    for (const c of all<CampaignRow>(db, `SELECT * FROM campaigns WHERE user_id = ? AND status = 'active'`, user.id)) {
      const s = campaignSettings(c)
      limits.invites += s.dailyInvites
      limits.messages += s.dailyMessages
      limits.profileViews += s.dailyProfileViews
    }

    const counts = one<{ pending: number | null; accepted: number | null; replies: number | null }>(
      db,
      `SELECT SUM(status = 'invited') AS pending,
              SUM(invited_at IS NOT NULL AND connected_at IS NOT NULL) AS accepted,
              SUM(replied_at IS NOT NULL) AS replies
       FROM leads WHERE user_id = ?`,
      user.id,
    )

    const out: Dashboard = {
      linkedin: linkedin.getAccount(user.id),
      today: {
        // The engine never exceeds the account-wide caps, whatever the campaigns add up to.
        invites: { done: done.invite, limit: Math.min(limits.invites, DAILY_LIMITS.invite.cap) },
        messages: { done: done.message, limit: Math.min(limits.messages, DAILY_LIMITS.message.cap) },
        profileViews: { done: done.view_profile, limit: Math.min(limits.profileViews, DAILY_LIMITS.view_profile.cap) },
      },
      pendingInvites: counts?.pending ?? 0,
      accepted: counts?.accepted ?? 0,
      replies: counts?.replies ?? 0,
      withinActiveHours: isWithinActiveHours(now, settings),
      nextActionAt: toIso(engine.nextActionAt(user.id)),
      activity: listActivities(db, { userId: user.id, limit: 20 }),
      campaigns: toCampaignSummaries(db, listCampaignRows(db, user.id, { orderBy: 'updated', limit: 5 })),
    }
    res.json(out)
  })

  return r
}
