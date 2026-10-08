/** Database seeding and an engine wired to a fake clock / rand / LinkedIn for the engine tests. */
import type {
  ActivityType,
  CampaignSettings,
  CampaignStatus,
  Delay,
  LeadInput,
  LinkedInStatus,
  Sequence,
  SequenceStep,
  StepConfig,
  StepKind,
  UserSettings,
} from '../../../shared/types.ts'
import { NO_DELAY, validateSequence } from '../../../shared/sequence.ts'
import { type DB, all, one, openDb, run } from '../../src/db/index.ts'
import { newId } from '../../src/ids.ts'
import { type Engine, createEngine } from '../../src/engine/engine.ts'
import { insertLeads } from '../../src/engine/leads.ts'
import type { ImportRow, LeadRow } from '../../src/engine/store.ts'
import { FakeLinkedIn } from './engine-fakes.ts'

export const MIN = 60_000
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR

/** Wednesday 7 Oct 2026, 10:00 UTC. */
export const T0 = Date.parse('2026-10-07T10:00:00.000Z')

/** Mon–Fri 09:00–18:00 UTC, gap 1–5 min. */
export const UTC_HOURS: UserSettings = {
  timezone: 'UTC',
  activeDays: [1, 2, 3, 4, 5],
  activeStart: '09:00',
  activeEnd: '18:00',
  gapMinMinutes: 1,
  gapMaxMinutes: 5,
}

export const CAMPAIGN_SETTINGS: CampaignSettings = {
  dailyInvites: 20,
  dailyMessages: 50,
  dailyProfileViews: 50,
  skipConnected: true,
  skipOtherCampaigns: false,
  stopOnReply: true,
}

export const profile = (id: string) => `https://www.linkedin.com/in/${id}/`

export interface TestEngine {
  db: DB
  li: FakeLinkedIn
  engine: Engine
  logs: string[]
  errors: string[]
  now(): number
  setNow(t: number): void
  advance(ms: number): void
  /** Set what rand() returns: a constant, or a function. */
  setRand(r: number | (() => number)): void
  /** advance past the user's gap, then tick */
  tickAfterGap(userId?: string): Promise<void>
}

export function setup(opts: { tickMs?: number } = {}): TestEngine {
  const db = openDb(':memory:')
  const li = new FakeLinkedIn()
  let t = T0
  let rand: () => number = () => 0.5
  const logs: string[] = []
  const errors: string[] = []
  const engine = createEngine({
    db,
    linkedin: li,
    tickMs: opts.tickMs ?? 1000,
    now: () => t,
    rand: () => rand(),
    log: (m) => logs.push(m),
    logError: (m, e) => errors.push(`${m}: ${e instanceof Error ? e.stack : String(e)}`),
  })
  const te: TestEngine = {
    db,
    li,
    engine,
    logs,
    errors,
    now: () => t,
    setNow: (v) => {
      t = v
    },
    advance: (ms) => {
      t += ms
    },
    setRand: (r) => {
      rand = typeof r === 'number' ? () => r : r
    },
    async tickAfterGap(userId?: string) {
      const rows = all<{ next_action_at: number | null }>(
        db,
        userId ? 'SELECT next_action_at FROM linkedin_accounts WHERE user_id = ?' : 'SELECT next_action_at FROM linkedin_accounts',
        ...(userId ? [userId] : []),
      )
      const gap = Math.max(0, ...rows.map((r) => r.next_action_at ?? 0))
      if (gap > t) t = gap
      await engine.tick()
    },
  }
  return te
}

export function addUser(
  db: DB,
  opts: { linkedin?: LinkedInStatus; settings?: Partial<UserSettings> | null; gapUntil?: number | null; name?: string } = {},
): string {
  const ws = newId('ws')
  const id = newId('usr')
  run(db, 'INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', ws, 'WS', T0)
  run(
    db,
    `INSERT INTO users (id, workspace_id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'x', 'owner', ?)`,
    id,
    ws,
    `${id}@example.com`,
    opts.name ?? 'Tester',
    T0,
  )
  if (opts.settings !== null) {
    const s = { ...UTC_HOURS, ...opts.settings }
    run(
      db,
      `INSERT INTO user_settings (user_id, timezone, active_days_json, active_start, active_end, gap_min_minutes, gap_max_minutes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      s.timezone,
      JSON.stringify(s.activeDays),
      s.activeStart,
      s.activeEnd,
      s.gapMinMinutes,
      s.gapMaxMinutes,
      T0,
    )
  }
  run(
    db,
    `INSERT INTO linkedin_accounts (user_id, status, next_action_at, updated_at) VALUES (?, ?, ?, ?)`,
    id,
    opts.linkedin ?? 'connected',
    opts.gapUntil ?? null,
    T0,
  )
  return id
}

export function addCampaign(
  db: DB,
  userId: string,
  opts: { sequence: Sequence; name?: string; status?: CampaignStatus; settings?: Partial<CampaignSettings>; createdAt?: number },
): string {
  const issues = validateSequence(opts.sequence)
  if (issues.length) throw new Error(`test sequence is invalid: ${issues.map((i) => i.message).join('; ')}`)
  const id = newId('cmp')
  run(
    db,
    `INSERT INTO campaigns (id, user_id, name, status, sequence_json, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    userId,
    opts.name ?? 'Campaign',
    opts.status ?? 'active',
    JSON.stringify(opts.sequence),
    JSON.stringify({ ...CAMPAIGN_SETTINGS, ...opts.settings }),
    opts.createdAt ?? T0,
    opts.createdAt ?? T0,
  )
  return id
}

/** Insert leads via insertLeads (root delay = its minimum). Returns the new lead ids in order. */
export function addLeads(db: DB, userId: string, campaignId: string, leads: (string | LeadInput)[], at = T0): string[] {
  const c = one<{ sequence_json: string; settings_json: string }>(db, 'SELECT sequence_json, settings_json FROM campaigns WHERE id = ?', campaignId)!
  const inputs = leads.map((l) => (typeof l === 'string' ? { profileUrl: profile(l) } : l))
  insertLeads(db, {
    userId,
    campaignId,
    sequence: JSON.parse(c.sequence_json),
    settings: JSON.parse(c.settings_json),
    leads: inputs,
    now: at,
    rand: () => 0,
  })
  return inputs.map(
    (l) => one<{ id: string }>(db, 'SELECT id FROM leads WHERE campaign_id = ? AND profile_url = ?', campaignId, normalize(l.profileUrl))!.id,
  )
}

const normalize = (url: string) => {
  const m = /\/in\/([^/?#]+)/.exec(url)
  return profile(decodeURIComponent(m![1]).toLowerCase())
}

export function addImport(
  db: DB,
  userId: string,
  campaignId: string,
  opts: { url?: string; max?: number; listName?: string; createdAt?: number; page?: number; collected?: number; status?: string } = {},
): string {
  const id = newId('imp')
  run(
    db,
    `INSERT INTO lead_imports (id, campaign_id, user_id, url, max_leads, collected, page, status, list_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    campaignId,
    userId,
    opts.url ?? 'https://www.linkedin.com/search/results/people/?keywords=founder',
    opts.max ?? 100,
    opts.collected ?? 0,
    opts.page ?? 1,
    opts.status ?? 'pending',
    opts.listName ?? 'Founders',
    opts.createdAt ?? T0,
    opts.createdAt ?? T0,
  )
  return id
}

export const getLead = (db: DB, id: string) => one<LeadRow>(db, 'SELECT * FROM leads WHERE id = ?', id)!
export const getImport = (db: DB, id: string) => one<ImportRow>(db, 'SELECT * FROM lead_imports WHERE id = ?', id)!
export const campaignStatus = (db: DB, id: string) => one<{ status: string }>(db, 'SELECT status FROM campaigns WHERE id = ?', id)!.status
export const account = (db: DB, userId: string) =>
  one<{ status: string; last_error: string | null; next_action_at: number | null }>(
    db,
    'SELECT status, last_error, next_action_at FROM linkedin_accounts WHERE user_id = ?',
    userId,
  )!

export interface ActivityRec {
  type: string
  status: string
  detail: string
  campaign_id: string | null
  campaign_name: string | null
  lead_id: string | null
  lead_name: string | null
  step_id: string | null
  created_at: number
}
export const activities = (db: DB, userId: string) =>
  all<ActivityRec>(
    db,
    'SELECT type, status, detail, campaign_id, campaign_name, lead_id, lead_name, step_id, created_at FROM activities WHERE user_id = ? ORDER BY rowid',
    userId,
  )

/** Successful activities of a type at `at` (to fill daily-limit counters). */
export function addSuccesses(db: DB, userId: string, campaignId: string | null, type: ActivityType, n: number, at: number) {
  for (let i = 0; i < n; i++)
    run(
      db,
      `INSERT INTO activities (id, user_id, campaign_id, campaign_name, type, status, detail, created_at) VALUES (?, ?, ?, 'C', ?, 'success', '', ?)`,
      newId('act'),
      userId,
      campaignId,
      type,
      at,
    )
}

/* ---------------------------------------------------------------- sequences */

export interface StepSpec {
  id?: string
  kind: StepKind
  delay?: Delay
  config?: StepConfig
  next?: string | null
  yes?: string | null
  no?: string | null
}

const defaultConfig = (kind: StepKind): StepConfig =>
  kind === 'message'
    ? { message: 'Hi {{first_name}}' }
    : kind === 'condition'
      ? { condition: 'accepted_invite', within: { value: 7, unit: 'days' } }
      : kind === 'invite'
        ? { message: '' }
        : {}

const toStep = (s: StepSpec, id: string): SequenceStep => ({
  id,
  kind: s.kind,
  delay: s.delay ?? { ...NO_DELAY },
  config: s.config ?? defaultConfig(s.kind),
  ...(s.next !== undefined ? { next: s.next } : {}),
  ...(s.yes !== undefined ? { yes: s.yes } : {}),
  ...(s.no !== undefined ? { no: s.no } : {}),
})

/** Steps s1 → s2 → … (no delays unless given). */
export function linear(...specs: (StepKind | StepSpec)[]): Sequence {
  const list = specs.map((s) => (typeof s === 'string' ? { kind: s } : s))
  const steps: Record<string, SequenceStep> = {}
  list.forEach((s, i) => {
    const id = s.id ?? `s${i + 1}`
    const next = i + 1 < list.length ? (list[i + 1].id ?? `s${i + 2}`) : null
    steps[id] = toStep({ ...s, next: s.kind === 'end' ? undefined : (s.next ?? next) }, id)
  })
  return { rootId: list.length ? (list[0].id ?? 's1') : null, steps }
}

/** A sequence from explicit steps (ids required). The first step is the root. */
export function tree(...specs: (StepSpec & { id: string })[]): Sequence {
  return { rootId: specs[0]?.id ?? null, steps: Object.fromEntries(specs.map((s) => [s.id, toStep(s, s.id)])) }
}
