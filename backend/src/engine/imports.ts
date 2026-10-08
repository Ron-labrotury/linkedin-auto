/** Search imports: collect one page of a LinkedIn people search into the campaign per unit. */
import type { LeadInput } from '../../../shared/types.ts'
import { run, tx } from '../db/index.ts'
import type { LinkedInDriver, SearchPage, SearchPerson } from '../linkedin/types.ts'
import { type EngineCtx, accountProblem, errorCode, errorText, logText, sessionExpired, tag, transientFailure } from './context.ts'
import { insertLeads } from './leads.ts'
import { MAX_ATTEMPTS, MAX_IMPORT_PAGES, nextDayWindow, transientBackoffAt } from './schedule.ts'
import { type CampaignData, type ImportRow, addActivity, readCampaign, readImport, readUserSettings } from './store.ts'

export interface ImportUnit {
  type: 'import'
  userId: string
  imp: ImportRow
  campaign: CampaignData
}

const isOpen = (r: ImportRow | undefined): r is ImportRow => !!r && (r.status === 'pending' || r.status === 'running')

export async function fetchImportPage(d: LinkedInDriver, u: ImportUnit): Promise<SearchPage> {
  const page = await d.searchPeople(u.imp.url, u.imp.page)
  if (!page || !Array.isArray(page.people)) throw new Error('Unexpected response from the LinkedIn driver')
  return page
}

const toLeadInput = (p: SearchPerson): LeadInput => ({
  profileUrl: String(p?.profileUrl ?? ''),
  firstName: p?.firstName,
  lastName: p?.lastName,
  headline: p?.headline,
  location: p?.location,
})

function activity(ctx: EngineCtx, u: ImportUnit, campaign: CampaignData | undefined, status: 'success' | 'failed', detail: string, now: number) {
  addActivity(ctx.db, {
    userId: u.userId,
    campaignId: u.campaign.id,
    campaignName: campaign?.name ?? u.campaign.name,
    leadId: null,
    leadName: null,
    stepId: null,
    type: 'import',
    status,
    detail,
    at: now,
  })
}

/** Store one page of results: new leads (deduplicated by insertLeads), progress, and completion. */
export function applyImportPage(ctx: EngineCtx, u: ImportUnit, res: SearchPage) {
  const now = ctx.now()
  const imp = readImport(ctx.db, u.imp.id)
  const campaign = readCampaign(ctx.db, u.campaign.id)
  if (!isOpen(imp) || !campaign) {
    ctx.log(`${tag(u.userId)} import page ${u.imp.page} → discarded (import removed or closed meanwhile)`)
    return
  }
  const remaining = Math.max(0, imp.max_leads - imp.collected)
  let added = 0
  const out = tx(ctx.db, () => {
    // Insert at most `remaining` new leads; duplicates don't count, so keep going through the page.
    let i = 0
    while (i < res.people.length && added < remaining) {
      const chunk = res.people.slice(i, i + (remaining - added))
      i += chunk.length
      added += insertLeads(ctx.db, {
        userId: u.userId,
        campaignId: campaign.id,
        sequence: campaign.sequence,
        settings: campaign.settings,
        leads: chunk.map(toLeadInput),
        defaultListName: imp.list_name,
        now,
        rand: ctx.rand,
      }).added
    }
    const collected = imp.collected + added
    const page = u.imp.page + 1
    const done = !res.hasMore || collected >= imp.max_leads || page > MAX_IMPORT_PAGES
    run(
      ctx.db,
      `UPDATE lead_imports SET collected = ?, page = ?, status = ?, attempts = 0, error = NULL, updated_at = ? WHERE id = ?`,
      collected,
      page,
      done ? 'done' : 'running',
      now,
      imp.id,
    )
    activity(ctx, u, campaign, 'success', `Collected ${added} lead${added === 1 ? '' : 's'} (page ${u.imp.page})`, now)
    return { collected, done }
  })
  ctx.log(`${tag(u.userId)} import page ${u.imp.page} → +${added} leads (${out.collected}/${imp.max_leads}${out.done ? ', done' : ''})`)
}

/**
 * A failed page: session_expired / account_problem pause the user and transient backs the user off,
 * without counting an attempt; anything else counts an attempt (3 → import failed).
 */
export function applyImportFailure(ctx: EngineCtx, u: ImportUnit, err: unknown) {
  const code = errorCode(err)
  if (code === 'session_expired') return sessionExpired(ctx, u.userId, err)
  if (code === 'account_problem') return accountProblem(ctx, u.userId, err)
  if (code === 'transient') {
    const until = transientFailure(ctx, u.userId, err)
    // After the back-off, let leads go first for a while: a search page that keeps failing must not
    // hold up the user's campaigns (imports are otherwise always picked before leads).
    ctx.throttle(u.userId, 'search', transientBackoffAt(until, ctx.rand))
    ctx.log(`${tag(u.userId)} import page ${u.imp.page} → transient failure, no attempt counted – user paused until ${new Date(until).toISOString()}: ${logText(err)}`)
    return
  }
  const now = ctx.now()
  const imp = readImport(ctx.db, u.imp.id)
  if (!isOpen(imp)) return
  const msg = errorText(err)
  const attempts = imp.attempts + 1
  const failed = attempts >= MAX_ATTEMPTS
  // LinkedIn throttled searches: leave imports alone until tomorrow so leads keep moving meanwhile.
  if (code === 'rate_limited' && !failed) ctx.throttle(u.userId, 'search', nextDayWindow(now, readUserSettings(ctx.db, u.userId)))
  tx(ctx.db, () => {
    run(
      ctx.db,
      `UPDATE lead_imports SET attempts = ?, error = ?, status = ?, updated_at = ? WHERE id = ?`,
      attempts,
      msg,
      failed ? 'failed' : imp.status,
      now,
      imp.id,
    )
    activity(ctx, u, readCampaign(ctx.db, u.campaign.id), 'failed', msg, now)
  })
  ctx.log(`${tag(u.userId)} import page ${u.imp.page} → ${code}, attempt ${attempts}/${MAX_ATTEMPTS}${failed ? ' – import failed' : ''}: ${logText(err)}`)
}
