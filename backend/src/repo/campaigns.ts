import type {
  ActivityType,
  Campaign,
  CampaignSettings,
  CampaignStats,
  CampaignStatus,
  CampaignSummary,
  ImportStatus,
  LeadImport,
  SearchImportInput,
  Sequence,
} from '../../../shared/types.ts'
import { countSteps, emptySequence } from '../../../shared/sequence.ts'
import { type DB, all, one, run } from '../db/index.ts'
import { newId } from '../ids.ts'
import { iso, parseJson } from './util.ts'

export interface CampaignRow {
  id: string
  user_id: string
  name: string
  status: CampaignStatus
  sequence_json: string
  settings_json: string
  created_at: number
  updated_at: number
}

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

/** Only used to fill gaps in a stored settings blob; the API always stores complete settings. */
const FALLBACK_SETTINGS: CampaignSettings = {
  dailyInvites: 20,
  dailyMessages: 50,
  dailyProfileViews: 50,
  skipConnected: true,
  skipOtherCampaigns: true,
  stopOnReply: true,
}

export const campaignSequence = (r: CampaignRow): Sequence => parseJson<Sequence>(r.sequence_json, emptySequence())

export const campaignSettings = (r: CampaignRow): CampaignSettings => ({
  ...FALLBACK_SETTINGS,
  ...parseJson<Partial<CampaignSettings>>(r.settings_json, {}),
})

export const toImport = (r: ImportRow): LeadImport => ({
  id: r.id,
  url: r.url,
  max: r.max_leads,
  collected: r.collected,
  status: r.status,
  listName: r.list_name,
  error: r.error,
  createdAt: iso(r.created_at),
})

const zeroStats = (): CampaignStats => ({
  totalLeads: 0,
  contacted: 0,
  invitesSent: 0,
  accepted: 0,
  messagesSent: 0,
  replied: 0,
  profileViews: 0,
  failed: 0,
})

/** Activity types that are an action on LinkedIn (not a detection, condition or import). */
export const LINKEDIN_ACTION_TYPES = ['view_profile', 'follow', 'like_post', 'invite', 'message', 'withdraw'] as const satisfies readonly ActivityType[]

/** Stats + pending imports for many campaigns with three grouped queries (no N+1). */
function aggregates(db: DB, ids: string[]) {
  const out = new Map(ids.map((id) => [id, { stats: zeroStats(), pendingImports: 0 }]))
  if (!ids.length) return out
  const idsJson = JSON.stringify(ids)

  const leadRows = all<{ id: string; total: number; invited: number; accepted: number; replied: number; failed: number }>(
    db,
    `SELECT campaign_id AS id,
            COUNT(*) AS total,
            SUM(invited_at IS NOT NULL) AS invited,
            SUM(invited_at IS NOT NULL AND connected_at IS NOT NULL) AS accepted,
            SUM(replied_at IS NOT NULL) AS replied,
            SUM(status = 'failed') AS failed
     FROM leads WHERE campaign_id IN (SELECT value FROM json_each(?)) GROUP BY campaign_id`,
    idsJson,
  )
  for (const r of leadRows) {
    const s = out.get(r.id)!.stats
    s.totalLeads = r.total
    s.invitesSent = r.invited ?? 0
    s.accepted = r.accepted ?? 0
    s.replied = r.replied ?? 0
    s.failed = r.failed ?? 0
  }

  // contacted: leads (still in the campaign) with at least one successful action on LinkedIn – a
  // skipped step or an evaluated condition does not count. Deleted leads' activities have lead_id NULL.
  const actRows = all<{ id: string; messages: number; views: number; contacted: number }>(
    db,
    `SELECT campaign_id AS id, SUM(type = 'message') AS messages, SUM(type = 'view_profile') AS views,
            COUNT(DISTINCT lead_id) AS contacted
     FROM activities
     WHERE campaign_id IN (SELECT value FROM json_each(?)) AND status = 'success'
       AND type IN (SELECT value FROM json_each(?))
     GROUP BY campaign_id`,
    idsJson,
    JSON.stringify(LINKEDIN_ACTION_TYPES),
  )
  for (const r of actRows) {
    const s = out.get(r.id)!.stats
    s.messagesSent = r.messages ?? 0
    s.profileViews = r.views ?? 0
    s.contacted = r.contacted ?? 0
  }

  const impRows = all<{ id: string; n: number }>(
    db,
    `SELECT campaign_id AS id, COUNT(*) AS n FROM lead_imports
     WHERE campaign_id IN (SELECT value FROM json_each(?)) AND status IN ('pending', 'running')
     GROUP BY campaign_id`,
    idsJson,
  )
  for (const r of impRows) out.get(r.id)!.pendingImports = r.n
  return out
}

export function toCampaignSummaries(db: DB, rows: CampaignRow[]): CampaignSummary[] {
  const agg = aggregates(
    db,
    rows.map((r) => r.id),
  )
  return rows.map((r) => {
    const a = agg.get(r.id)!
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
      stats: a.stats,
      stepCount: countSteps(campaignSequence(r)),
      pendingImports: a.pendingImports,
    }
  })
}

export function toCampaign(db: DB, row: CampaignRow): Campaign {
  const imports = all<ImportRow>(db, 'SELECT * FROM lead_imports WHERE campaign_id = ? ORDER BY created_at, rowid', row.id)
  return {
    ...toCampaignSummaries(db, [row])[0],
    sequence: campaignSequence(row),
    settings: campaignSettings(row),
    imports: imports.map(toImport),
  }
}

/** The user's campaign, or undefined (also for other users' campaigns). */
export const getCampaignRow = (db: DB, userId: string, id: string) =>
  one<CampaignRow>(db, 'SELECT * FROM campaigns WHERE id = ? AND user_id = ?', id, userId)

export function listCampaignRows(db: DB, userId: string, opts: { orderBy?: 'created' | 'updated'; limit?: number } = {}) {
  const order = opts.orderBy === 'updated' ? 'updated_at DESC, rowid DESC' : 'created_at DESC, rowid DESC'
  return all<CampaignRow>(db, `SELECT * FROM campaigns WHERE user_id = ? ORDER BY ${order} LIMIT ?`, userId, opts.limit ?? -1)
}

/** Queue people-search URLs for the engine to collect. Returns the number of imports created. */
export function insertImports(db: DB, userId: string, campaignId: string, imports: SearchImportInput[], now = Date.now()) {
  for (const imp of imports) {
    run(
      db,
      `INSERT INTO lead_imports (id, campaign_id, user_id, url, max_leads, status, list_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      newId('imp'),
      campaignId,
      userId,
      imp.url.trim(),
      imp.max,
      (imp.listName ?? '').trim().slice(0, 100),
      now,
      now,
    )
  }
  return imports.length
}

/** A lead the engine will still act on (it has a scheduled step). */
export const hasRunnableLead = (db: DB, campaignId: string) =>
  !!one(
    db,
    `SELECT 1 FROM leads WHERE campaign_id = ? AND next_action_at IS NOT NULL
       AND status NOT IN ('finished', 'skipped', 'failed') LIMIT 1`,
    campaignId,
  )

export const hasPendingImport = (db: DB, campaignId: string) =>
  !!one(db, `SELECT 1 FROM lead_imports WHERE campaign_id = ? AND status IN ('pending', 'running') LIMIT 1`, campaignId)

export const countLeads = (db: DB, campaignId: string) =>
  one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM leads WHERE campaign_id = ?', campaignId)!.n
