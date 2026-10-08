/**
 * Adding leads to a campaign. Used by the API (create campaign / add leads) and by the
 * engine (search imports), so both apply the same de-duplication and scheduling rules.
 */
import type { CampaignSettings, LeadInput, Sequence } from '../../../shared/types.ts'
import { normalizeProfileUrl, publicIdFromUrl, nameFromPublicId } from '../../../shared/linkedin-url.ts'
import { pickDelayMs } from '../../../shared/sequence.ts'
import { type DB, one, run, tx } from '../db/index.ts'
import { newId } from '../ids.ts'

export interface InsertLeadsResult {
  added: number
  skipped: number
}

const clip = (s: string | undefined, n: number) => (s ?? '').trim().slice(0, n)

/**
 * Insert leads into `campaignId`. Invalid URLs and duplicates within the campaign are dropped
 * (counted as skipped). With `skipOtherCampaigns`, a person who is still in progress (status not
 * finished / skipped / failed) in another active, paused or draft campaign of the same user is
 * stored with status "skipped". New leads start at the sequence root with the root step's random
 * delay. (The engine checks again before a lead's first LinkedIn action, see docs/ENGINE.md.)
 */
export function insertLeads(
  db: DB,
  opts: {
    userId: string
    campaignId: string
    sequence: Sequence
    settings: CampaignSettings
    leads: LeadInput[]
    defaultListName?: string
    now?: number
    rand?: () => number
  },
): InsertLeadsResult {
  const now = opts.now ?? Date.now()
  const root = opts.sequence.rootId ? opts.sequence.steps[opts.sequence.rootId] : undefined
  let added = 0
  let skipped = 0

  const insert = db.prepare(`
    INSERT OR IGNORE INTO leads
      (id, campaign_id, user_id, public_id, profile_url, first_name, last_name, headline, company, location,
       list_name, status, current_step_id, step_started_at, next_action_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)

  tx(db, () => {
    for (const input of opts.leads) {
      const url = normalizeProfileUrl(input.profileUrl ?? '')
      const publicId = url ? publicIdFromUrl(url) : null
      if (!url || !publicId) {
        skipped++
        continue
      }
      const inOther = opts.settings.skipOtherCampaigns
        ? one<{ name: string }>(
            db,
            `SELECT c.name FROM leads l JOIN campaigns c ON c.id = l.campaign_id
             WHERE l.user_id = ? AND l.public_id = ? AND l.campaign_id <> ? AND c.status IN ('active', 'paused', 'draft')
               AND l.status NOT IN ('finished', 'skipped', 'failed')
             ORDER BY c.created_at, c.rowid LIMIT 1`,
            opts.userId,
            publicId,
            opts.campaignId,
          )
        : undefined
      const guess = nameFromPublicId(publicId)
      const due = root ? now + pickDelayMs(root.delay, opts.rand) : null
      const res = insert.run(
        newId('lead'),
        opts.campaignId,
        opts.userId,
        publicId,
        url,
        clip(input.firstName, 100) || guess.firstName,
        clip(input.lastName, 100) || guess.lastName,
        clip(input.headline, 300),
        clip(input.company, 200),
        clip(input.location, 200),
        clip(input.listName, 100) || clip(opts.defaultListName, 100),
        inOther ? 'skipped' : 'queued',
        inOther ? null : (root?.id ?? null),
        inOther ? null : due,
        inOther ? null : due,
        now,
      )
      if (res.changes === 0) skipped++ // duplicate within this campaign
      else if (inOther) {
        skipped++
        run(
          db,
          `UPDATE leads SET error = ?, last_action = 'Skipped' WHERE campaign_id = ? AND public_id = ?`,
          `Already in campaign “${inOther.name}”`,
          opts.campaignId,
          publicId,
        )
      } else added++
    }
  })
  return { added, skipped }
}
