import { Router } from 'express'
import { z } from 'zod'
import type { AddLeadsResponse, CampaignStatus, Sequence } from '../../../shared/types.ts'
import { validateSequence } from '../../../shared/sequence.ts'
import { isValidSearchUrl } from '../../../shared/linkedin-url.ts'
import { type DB, run, tx } from '../db/index.ts'
import { newId } from '../ids.ts'
import { insertLeads } from '../engine/leads.ts'
import { reconcileLeads } from '../engine/reconcile.ts'
import { HttpError, validationError } from '../http/errors.ts'
import { body, query } from '../http/request.ts'
import type { AppDeps } from '../http/types.ts'
import { auth } from '../auth/middleware.ts'
import {
  type CampaignRow,
  campaignSequence,
  campaignSettings,
  countLeads,
  getCampaignRow,
  hasPendingImport,
  hasRunnableLead,
  insertImports,
  listCampaignRows,
  toCampaign,
  toCampaignSummaries,
} from '../repo/campaigns.ts'
import { LEAD_STATUSES, deleteLeads, listLeads } from '../repo/leads.ts'
import { listActivities } from '../repo/activities.ts'
import { jsonEqual } from '../repo/util.ts'

export const MAX_LEADS_PER_REQUEST = 5000
const MAX_IMPORTS_PER_REQUEST = 50

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const campaignNameSchema = z
  .string('Enter a campaign name')
  .trim()
  .min(1, 'Enter a campaign name')
  .max(80, 'Campaign name must be at most 80 characters')

const dailyLimit = (label: string, max: number) =>
  z
    .number(`${label} must be a number`)
    .int(`${label} must be a whole number`)
    .min(0, `${label} must be between 0 and ${max}`)
    .max(max, `${label} must be between 0 and ${max}`)

export const campaignSettingsSchema = z.object(
  {
    dailyInvites: dailyLimit('Daily invites', 200),
    dailyMessages: dailyLimit('Daily messages', 300),
    dailyProfileViews: dailyLimit('Daily profile views', 300),
    skipConnected: z.boolean('skipConnected must be true or false'),
    skipOtherCampaigns: z.boolean('skipOtherCampaigns must be true or false'),
    stopOnReply: z.boolean('stopOnReply must be true or false'),
  },
  'Campaign settings are required',
)

const optText = z
  .string()
  .max(2000)
  .nullish()
  .transform((v) => v ?? undefined)

const leadSchema = z.object({
  profileUrl: z.string('Each lead needs a profileUrl').max(2000, 'Profile URL is too long'),
  firstName: optText,
  lastName: optText,
  headline: optText,
  company: optText,
  location: optText,
  listName: optText,
})

const searchImportSchema = z.object({
  url: z
    .string('Enter a LinkedIn search URL')
    .trim()
    .max(4000, 'Search URL is too long')
    .refine(isValidSearchUrl, 'Use a LinkedIn people-search URL (https://www.linkedin.com/search/results/people/?…)'),
  max: z
    .number('Max leads must be a number')
    .int('Max leads must be a whole number')
    .min(1, 'Max leads must be between 1 and 1000')
    .max(1000, 'Max leads must be between 1 and 1000'),
  listName: z
    .string()
    .trim()
    .max(100, 'List name must be at most 100 characters')
    .nullish()
    .transform((v) => v ?? ''),
})

const leadsSchema = z.array(leadSchema, 'leads must be a list').max(MAX_LEADS_PER_REQUEST, `At most ${MAX_LEADS_PER_REQUEST} leads per request`)
const importsSchema = z
  .array(searchImportSchema, 'searchImports must be a list')
  .max(MAX_IMPORTS_PER_REQUEST, `At most ${MAX_IMPORTS_PER_REQUEST} search URLs per request`)

const createSchema = z.object({
  name: campaignNameSchema,
  status: z.enum(['active', 'draft'], 'Status must be "active" or "draft"').default('draft'),
  settings: campaignSettingsSchema,
  leads: leadsSchema.default([]),
  searchImports: importsSchema.default([]),
})

const updateSchema = z.object({
  name: campaignNameSchema.optional(),
  status: z.enum(['draft', 'active', 'paused', 'completed'], 'Unknown campaign status').optional(),
  settings: campaignSettingsSchema.optional(),
})

const addLeadsSchema = z.object({ leads: leadsSchema.default([]), searchImports: importsSchema.default([]) })

const deleteLeadsSchema = z.object({
  ids: z
    .array(z.string().max(100), 'ids must be a list of lead ids')
    .min(1, 'Select at least one lead')
    .max(MAX_LEADS_PER_REQUEST, `At most ${MAX_LEADS_PER_REQUEST} leads per request`),
})

const leadsQuerySchema = z.object({
  status: z.enum(LEAD_STATUSES, 'Unknown lead status').optional(),
  q: z.string().trim().max(200, 'Search text is too long').optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(50)
    .transform((n) => Math.min(n, 200)),
})

/** Structure only; meaning (references, loops, content) is checked by validateSequence. */
const stepShape = z.object({
  id: z.string().max(100),
  kind: z.string().max(40),
  delay: z.object({ min: z.number(), max: z.number(), unit: z.string() }),
  config: z
    .object({
      message: z
        .string()
        .nullish()
        .transform((v) => v ?? undefined),
      condition: z
        .string()
        .nullish()
        .transform((v) => v ?? undefined),
      within: z
        .object({ value: z.number(), unit: z.string() })
        .nullish()
        .transform((v) => v ?? undefined),
    })
    .nullish()
    .transform((v) => v ?? {}),
  next: z.string().nullish(),
  yes: z.string().nullish(),
  no: z.string().nullish(),
})
const sequenceShape = z.object({ rootId: z.string().nullable(), steps: z.record(z.string(), stepShape) })

/** A sanitized sequence, or the first problem as text. */
export function checkSequence(raw: unknown): { sequence: Sequence; error?: undefined } | { sequence?: undefined; error: string } {
  if (raw === undefined) return { error: 'Add a sequence' }
  const parsed = sequenceShape.safeParse(raw)
  if (!parsed.success) return { error: 'Sequence is malformed' }
  const sequence = parsed.data as unknown as Sequence
  const issues = validateSequence(sequence)
  return issues.length ? { error: issues[0].message } : { sequence }
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

/** Why `from → to` is not allowed (null = allowed; activation has further checks). */
export function transitionError(from: CampaignStatus, to: CampaignStatus): string | null {
  if (from === to) return null
  if (to === 'draft') return 'A campaign can’t be moved back to draft'
  if (to === 'active') return null
  if (to === 'paused') return from === 'active' ? null : 'Only an active campaign can be paused'
  return 'A campaign is completed automatically once every lead has finished'
}

/** 422 unless the campaign has steps and something for the engine to do. */
function assertCanActivate(db: DB, campaignId: string, sequence: Sequence) {
  if (!sequence.rootId) throw new HttpError(422, 'Add at least one step to the sequence before starting the campaign')
  if (hasRunnableLead(db, campaignId) || hasPendingImport(db, campaignId)) return
  throw new HttpError(
    422,
    countLeads(db, campaignId)
      ? 'No lead is waiting for a step. Add new leads before starting the campaign.'
      : 'Add at least one lead or LinkedIn search before starting the campaign',
  )
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export function campaignsRouter({ db }: AppDeps) {
  const r = Router()

  const mustGet = (userId: string, id: string): CampaignRow => {
    const row = getCampaignRow(db, userId, id)
    if (!row) throw new HttpError(404, 'Campaign not found')
    return row
  }

  r.get('/', (req, res) => {
    res.json(toCampaignSummaries(db, listCampaignRows(db, auth(req).user.id)))
  })

  r.post('/', (req, res) => {
    const { user } = auth(req)
    const raw = body(req) as { sequence?: unknown }
    const parsed = createSchema.safeParse(raw)
    const seq = checkSequence(raw?.sequence)
    if (!parsed.success || seq.error !== undefined)
      throw validationError(parsed.success ? null : parsed.error, seq.error !== undefined ? { sequence: seq.error } : {})
    const input = parsed.data
    const sequence = seq.sequence
    const now = Date.now()
    const id = newId('cmp')

    const row = tx(db, () => {
      run(
        db,
        `INSERT INTO campaigns (id, user_id, name, status, sequence_json, settings_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        user.id,
        input.name,
        input.status,
        JSON.stringify(sequence),
        JSON.stringify(input.settings),
        now,
        now,
      )
      if (input.leads.length) insertLeads(db, { userId: user.id, campaignId: id, sequence, settings: input.settings, leads: input.leads, now })
      insertImports(db, user.id, id, input.searchImports, now)
      if (input.status === 'active') assertCanActivate(db, id, sequence)
      return getCampaignRow(db, user.id, id)!
    })
    res.status(201).json(toCampaign(db, row))
  })

  r.get('/:id', (req, res) => {
    res.json(toCampaign(db, mustGet(auth(req).user.id, req.params.id)))
  })

  r.patch('/:id', (req, res) => {
    const { user } = auth(req)
    const raw = body(req) as { sequence?: unknown }
    const parsed = updateSchema.safeParse(raw)
    const seq = raw?.sequence === undefined ? null : checkSequence(raw.sequence)
    if (!parsed.success || seq?.error !== undefined)
      throw validationError(parsed.success ? null : parsed.error, seq?.error !== undefined ? { sequence: seq.error } : {})
    const input = parsed.data
    const row = mustGet(user.id, req.params.id)
    const now = Date.now()

    const updated = tx(db, () => {
      let sequence = campaignSequence(row)
      const sets: string[] = []
      const params: unknown[] = []

      if (seq?.sequence && !jsonEqual(seq.sequence, sequence)) {
        if (row.status === 'active') throw new HttpError(422, 'Pause the campaign before editing its sequence')
        sequence = seq.sequence
        run(db, 'UPDATE campaigns SET sequence_json = ? WHERE id = ?', JSON.stringify(sequence), row.id)
        reconcileLeads(db, row.id, sequence, now)
      }
      if (input.name !== undefined) {
        sets.push('name = ?')
        params.push(input.name)
      }
      if (input.settings) {
        sets.push('settings_json = ?')
        params.push(JSON.stringify(input.settings))
      }
      if (input.status && input.status !== row.status) {
        const err = transitionError(row.status, input.status)
        if (err) throw new HttpError(422, err)
        if (input.status === 'active') assertCanActivate(db, row.id, sequence)
        sets.push('status = ?')
        params.push(input.status)
      }
      sets.push('updated_at = ?')
      params.push(now)
      run(db, `UPDATE campaigns SET ${sets.join(', ')} WHERE id = ?`, ...params, row.id)
      return getCampaignRow(db, user.id, row.id)!
    })
    res.json(toCampaign(db, updated))
  })

  r.delete('/:id', (req, res) => {
    const { user } = auth(req)
    const out = run(db, 'DELETE FROM campaigns WHERE id = ? AND user_id = ?', req.params.id, user.id)
    if (!out.changes) throw new HttpError(404, 'Campaign not found')
    res.status(204).end()
  })

  r.get('/:id/leads', (req, res) => {
    const { user } = auth(req)
    const row = mustGet(user.id, req.params.id)
    const f = leadsQuerySchema.parse(query(req))
    res.json(listLeads(db, row.id, f))
  })

  r.post('/:id/leads', (req, res) => {
    const { user } = auth(req)
    const row = mustGet(user.id, req.params.id)
    const input = addLeadsSchema.parse(body(req))
    if (!input.leads.length && !input.searchImports.length) throw new HttpError(400, 'Add at least one profile URL or search URL')
    const now = Date.now()
    const out = tx(db, (): AddLeadsResponse => {
      const { added, skipped } = input.leads.length
        ? insertLeads(db, {
            userId: user.id,
            campaignId: row.id,
            sequence: campaignSequence(row),
            settings: campaignSettings(row),
            leads: input.leads,
            now,
          })
        : { added: 0, skipped: 0 }
      const imports = insertImports(db, user.id, row.id, input.searchImports, now)
      run(db, 'UPDATE campaigns SET updated_at = ? WHERE id = ?', now, row.id)
      return { added, skipped, imports }
    })
    res.json(out)
  })

  r.delete('/:id/leads', (req, res) => {
    const { user } = auth(req)
    const row = mustGet(user.id, req.params.id)
    const { ids } = deleteLeadsSchema.parse(body(req))
    tx(db, () => {
      if (deleteLeads(db, user.id, row.id, ids)) run(db, 'UPDATE campaigns SET updated_at = ? WHERE id = ?', Date.now(), row.id)
    })
    res.status(204).end()
  })

  r.get('/:id/activity', (req, res) => {
    const { user } = auth(req)
    const row = mustGet(user.id, req.params.id)
    const { limit } = z
      .object({
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .default(100)
          .transform((n) => Math.min(n, 500)),
      })
      .parse(query(req))
    res.json(listActivities(db, { userId: user.id, campaignId: row.id, limit }))
  })

  return r
}
