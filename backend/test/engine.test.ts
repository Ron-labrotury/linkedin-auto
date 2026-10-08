/** Engine scheduling (docs/ENGINE.md "Tick", "Imports", "Campaign completion") and nextActionAt. */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { all, run } from '../src/db/index.ts'
import { createEngine } from '../src/engine/engine.ts'
import { reconcileLeads } from '../src/engine/reconcile.ts'
import { gapMs, nextDayWindow, recheckAt, retryAt } from '../src/engine/schedule.ts'
import { DEFAULT_SETTINGS } from '../../shared/time.ts'
import { FakeLinkedIn, deferred, linkedInError, until } from './helpers/engine-fakes.ts'
import {
  DAY,
  HOUR,
  MIN,
  T0,
  UTC_HOURS,
  account,
  activities,
  addCampaign,
  addImport,
  addLeads,
  addSuccesses,
  addUser,
  campaignStatus,
  getImport,
  getLead,
  linear,
  profile,
  setup,
  tree,
} from './helpers/engine-setup.ts'

const SAT = Date.parse('2026-10-10T10:00:00.000Z')
const THU_9 = Date.parse('2026-10-08T09:00:00.000Z')
const person = (id: string, first = 'P', last = id) => ({ profileUrl: profile(id), firstName: first, lastName: last, headline: 'Engineer', location: 'Pune' })

/** One user with one active campaign of `n` due view_profile leads. */
function basic(n = 1, userOpts: Parameters<typeof addUser>[1] = {}) {
  const e = setup()
  const user = addUser(e.db, userOpts)
  const campaign = addCampaign(e.db, user, { sequence: linear('view_profile', { kind: 'follow', delay: { min: 1, max: 1, unit: 'days' } }) })
  const leads = addLeads(e.db, user, campaign, Array.from({ length: n }, (_, i) => `lead-${'abcdefghij'[i]}`))
  return { e, user, campaign, leads }
}

describe('engine: random gap between actions', () => {
  it('sets next_action_at = now + gapMin…gapMax minutes after a success', async () => {
    for (const [r, expected] of [
      [0, MIN],
      [0.5, 3 * MIN],
      [1, 5 * MIN],
    ] as const) {
      const { e, user } = basic()
      e.setRand(r)
      await e.engine.tick()
      assert.equal(account(e.db, user).next_action_at, T0 + expected)
    }
    const { e, user } = basic(1, { settings: { gapMinMinutes: 2, gapMaxMinutes: 2 } })
    await e.engine.tick()
    assert.equal(account(e.db, user).next_action_at, T0 + 2 * MIN)
  })

  it('uses the time the action finished', async () => {
    const { e, user } = basic()
    e.li.queue('viewProfile', (url: string) => {
      e.advance(40_000) // the browser took 40 s
      return { firstName: 'A', lastName: 'B', headline: '', company: '', location: '', profileUrl: url, connection: 'not_connected' }
    })
    await e.engine.tick()
    assert.equal(account(e.db, user).next_action_at, T0 + 40_000 + 3 * MIN)
  })

  it('sets the gap after a failure too', async () => {
    const { e, user } = basic()
    e.li.queue('viewProfile', linkedInError('unknown', 'boom'))
    await e.engine.tick()
    assert.equal(account(e.db, user).next_action_at, T0 + 3 * MIN)
  })

  it('waits for the gap before the next action', async () => {
    const { e, user, leads } = basic(2)
    await e.engine.tick()
    assert.equal(e.li.calls.length, 1)
    e.advance(3 * MIN - 1000)
    await e.engine.tick()
    assert.equal(e.li.calls.length, 1)
    e.advance(1000)
    await e.engine.tick()
    assert.equal(e.li.calls.length, 2)
    assert.equal(getLead(e.db, leads[1]).last_action_at, T0 + 3 * MIN)
    assert.equal(account(e.db, user).next_action_at, T0 + 6 * MIN)
  })

  it('gapMs rounds to whole seconds and tolerates odd settings', () => {
    assert.equal(gapMs({ gapMinMinutes: 1, gapMaxMinutes: 5 }, () => 0.123456), Math.round((1 + 0.123456 * 4) * 60) * 1000)
    assert.equal(gapMs({ gapMinMinutes: 0, gapMaxMinutes: 0 }, () => 0.7), 0)
    assert.equal(gapMs({ gapMinMinutes: 3, gapMaxMinutes: 1 }, () => 0.7), 3 * MIN)
  })
})

describe('engine: who gets work', () => {
  it('does nothing outside active hours (days, start inclusive, end exclusive)', async () => {
    const { e, leads } = basic()
    run(e.db, 'UPDATE leads SET next_action_at = ?', Date.parse('2026-10-07T08:00:00Z'))
    for (const t of [SAT, Date.parse('2026-10-07T08:59:00Z'), Date.parse('2026-10-07T18:00:00Z'), Date.parse('2026-10-07T23:00:00Z')]) {
      e.setNow(t)
      await e.engine.tick()
      assert.equal(e.li.sessions.length, 0, new Date(t).toISOString())
    }
    e.setNow(Date.parse('2026-10-07T09:00:00Z'))
    await e.engine.tick()
    assert.equal(e.li.sessions.length, 1)
    assert.equal(getLead(e.db, leads[0]).status, 'in_progress')
  })

  it('uses the user time zone, and DEFAULT_SETTINGS when the user has no settings row', async () => {
    // T0 = 15:30 in Asia/Kolkata (Wednesday) → inside the default 09:00–18:00
    const a = basic(1, { settings: null })
    await a.e.engine.tick()
    assert.equal(a.e.li.sessions.length, 1)
    // 13:00 UTC = 18:30 IST → outside
    const b = basic(1, { settings: null })
    b.e.setNow(Date.parse('2026-10-07T13:00:00Z'))
    await b.e.engine.tick()
    assert.equal(b.e.li.sessions.length, 0)
    // New York: 10:00 UTC = 06:00 EDT → outside; 14:00 UTC = 10:00 EDT → inside
    const c = basic(1, { settings: { timezone: 'America/New_York' } })
    await c.e.engine.tick()
    assert.equal(c.e.li.sessions.length, 0)
    c.e.setNow(Date.parse('2026-10-07T14:00:00Z'))
    await c.e.engine.tick()
    assert.equal(c.e.li.sessions.length, 1)
  })

  it('falls back to defaults for corrupt settings instead of crashing', async () => {
    const { e, user } = basic()
    run(e.db, `UPDATE user_settings SET timezone = 'Mars/Olympus', active_days_json = 'nope' WHERE user_id = ?`, user)
    await e.engine.tick() // default zone Asia/Kolkata, default days Mon–Fri
    assert.equal(e.li.sessions.length, 1)
    assert.deepEqual(e.errors, [])
  })

  for (const status of ['paused', 'draft', 'completed'] as const) {
    it(`ignores leads and imports of ${status} campaigns`, async () => {
      const e = setup()
      const user = addUser(e.db)
      const c = addCampaign(e.db, user, { sequence: linear('view_profile'), status })
      addLeads(e.db, user, c, ['a-a'])
      addImport(e.db, user, c)
      await e.engine.tick()
      assert.equal(e.li.sessions.length, 0)
      assert.equal(campaignStatus(e.db, c), status)
    })
  }

  for (const status of ['disconnected', 'expired', 'needs_verification', 'needs_app_approval', 'error'] as const) {
    it(`ignores users whose LinkedIn account is ${status}`, async () => {
      const { e } = basic(1, { linkedin: status })
      await e.engine.tick()
      assert.equal(e.li.sessions.length, 0)
    })
  }

  it('does one LinkedIn unit per user per tick', async () => {
    const { e, leads } = basic(3, { settings: { gapMinMinutes: 0, gapMaxMinutes: 0 } })
    await e.engine.tick()
    assert.equal(e.li.calls.length, 1)
    await e.engine.tick()
    await e.engine.tick()
    assert.equal(e.li.calls.length, 3)
    for (const id of leads) assert.equal(getLead(e.db, id).current_step_id, 's2')
  })

  it('picks the most overdue lead first', async () => {
    const { e, leads } = basic(3)
    run(e.db, 'UPDATE leads SET next_action_at = ? WHERE id = ?', T0 - HOUR, leads[2])
    run(e.db, 'UPDATE leads SET next_action_at = ? WHERE id = ?', T0 + HOUR, leads[0])
    await e.engine.tick()
    assert.equal(e.li.calls[0].args[0], profile('lead-c'))
    await e.tickAfterGap()
    assert.equal(e.li.calls[1].args[0], profile('lead-b'))
    await e.tickAfterGap()
    assert.equal(e.li.calls.length, 2) // lead-a not due yet
  })

  it('processes users independently: a slow user does not hold up others', async () => {
    const e = setup()
    const slow = addUser(e.db)
    const fast = addUser(e.db)
    for (const u of [slow, fast]) addLeads(e.db, u, addCampaign(e.db, u, { sequence: linear('view_profile', 'follow') }), ['x-x', 'y-y'])
    const hang = deferred<unknown>()
    e.li.queueFor(slow, 'viewProfile', hang.promise)

    const first = e.engine.tick()
    assert.equal(e.engine.tick(), first) // never two ticks at once
    await until(() => account(e.db, fast).next_action_at !== null, 'fast user')
    assert.equal(e.li.callsOf('viewProfile', slow).length, 1)
    assert.equal(account(e.db, fast).next_action_at, T0 + 3 * MIN)
    assert.equal(account(e.db, slow).next_action_at, null) // still running

    hang.resolve(linkedInError('unknown', 'timeout'))
    await first
    assert.equal(e.li.sessions.filter((s) => s === slow).length, 1)
    assert.equal(account(e.db, slow).next_action_at, T0 + 3 * MIN)
  })

  it('start() runs passes on a timer, never a second unit while one runs, and stop() ends them', async () => {
    const e = setup({ tickMs: 100 })
    const user = addUser(e.db, { settings: { gapMinMinutes: 0, gapMaxMinutes: 0 } })
    const c = addCampaign(e.db, user, { sequence: linear('view_profile', { kind: 'follow', delay: { min: 1, max: 1, unit: 'days' } }) })
    addLeads(e.db, user, c, ['t-a', 't-b', 't-c'])
    const hang = deferred<unknown>()
    e.li.queue('viewProfile', hang.promise)
    e.engine.start()
    e.engine.start() // idempotent
    try {
      await until(() => e.li.calls.length === 1, 'a timer pass')
      await new Promise((r) => setTimeout(r, 350)) // several passes while the unit runs
      assert.equal(e.li.sessions.length, 1)
      hang.resolve(linkedInError('unknown', 'slow'))
      await until(() => e.li.calls.length === 2, 'the next unit')
    } finally {
      e.engine.stop()
    }
    await new Promise((r) => setTimeout(r, 50))
    const n = e.li.calls.length
    await new Promise((r) => setTimeout(r, 350))
    assert.equal(e.li.calls.length, n)
    assert.ok(n < 4)
    assert.ok(e.logs.some((l) => l.includes('[engine] started')))
    assert.deepEqual(e.errors, [])
  })

  it('survives a service that throws synchronously', async () => {
    const { e, leads } = basic()
    e.li.withDriver = (() => {
      throw new Error('browser crashed')
    }) as typeof e.li.withDriver
    await e.engine.tick()
    assert.equal(getLead(e.db, leads[0]).attempts, 1)
    assert.deepEqual(e.errors, [])
  })

  it('survives a corrupt sequence (lead is re-scheduled from an empty sequence)', async () => {
    const { e, campaign, leads } = basic()
    run(e.db, `UPDATE campaigns SET sequence_json = '{oops' WHERE id = ?`, campaign)
    await e.engine.tick()
    assert.equal(getLead(e.db, leads[0]).next_action_at, null)
    assert.equal(e.li.sessions.length, 0)
    assert.deepEqual(e.errors, [])
  })
})

describe('engine: daily limits', () => {
  /** user with campaign A (invite → wait) holding `n` due leads */
  function invites(n: number, settings = {}, userSettings = {}) {
    const e = setup()
    const user = addUser(e.db, { settings: userSettings })
    const a = addCampaign(e.db, user, { sequence: linear('invite', { kind: 'follow', delay: { min: 1, max: 1, unit: 'days' } }), settings, name: 'A' })
    const leads = addLeads(e.db, user, a, Array.from({ length: n }, (_, i) => `inv-${'abcdefgh'[i]}`))
    return { e, user, a, leads }
  }

  it('postpones to the next day window when the campaign limit is reached, and keeps looking', async () => {
    const { e, user, a, leads } = invites(2, { dailyInvites: 2 })
    addSuccesses(e.db, user, a, 'invite', 2, T0 - HOUR)
    const b = addCampaign(e.db, user, { sequence: linear('view_profile'), name: 'B' })
    const [viewer] = addLeads(e.db, user, b, ['viewer-x'], T0 + 1000)
    e.advance(2000)
    await e.engine.tick()
    for (const id of leads) assert.equal(getLead(e.db, id).next_action_at, THU_9)
    assert.deepEqual(e.li.calls.map((c) => c.method), ['viewProfile'])
    assert.equal(getLead(e.db, viewer).status, 'finished')
    assert.ok(e.logs.some((l) => l.includes('daily limit of campaign "A"')))
  })

  it('counts only successes since local midnight in the user time zone', async () => {
    // T0 = 15:30 IST; 2026-10-06T19:00Z = 00:30 IST today; 18:00Z = 23:30 IST yesterday
    const today = invites(1, { dailyInvites: 1 }, { timezone: 'Asia/Kolkata' })
    addSuccesses(today.e.db, today.user, today.a, 'invite', 1, Date.parse('2026-10-06T19:00:00Z'))
    await today.e.engine.tick()
    assert.equal(today.e.li.calls.length, 0)
    assert.equal(getLead(today.e.db, today.leads[0]).next_action_at, Date.parse('2026-10-08T03:30:00Z')) // Thu 09:00 IST

    const yesterday = invites(1, { dailyInvites: 1 }, { timezone: 'Asia/Kolkata' })
    addSuccesses(yesterday.e.db, yesterday.user, yesterday.a, 'invite', 1, Date.parse('2026-10-06T18:00:00Z'))
    await yesterday.e.engine.tick()
    assert.equal(yesterday.e.li.callsOf('sendInvite').length, 1)
  })

  it('skipped and failed activities do not count; other campaigns do not count', async () => {
    const { e, user, a } = invites(1, { dailyInvites: 1 })
    run(e.db, `INSERT INTO activities (id, user_id, campaign_id, type, status, detail, created_at) VALUES ('x1', ?, ?, 'invite', 'skipped', '', ?)`, user, a, T0 - MIN)
    run(e.db, `INSERT INTO activities (id, user_id, campaign_id, type, status, detail, created_at) VALUES ('x2', ?, ?, 'invite', 'failed', '', ?)`, user, a, T0 - MIN)
    const other = addCampaign(e.db, user, { sequence: linear('invite'), status: 'paused' })
    addSuccesses(e.db, user, other, 'invite', 5, T0 - MIN)
    await e.engine.tick()
    assert.equal(e.li.callsOf('sendInvite').length, 1)
  })

  it('applies the account-wide caps across campaigns (100 invites, 150 messages, 250 views)', async () => {
    for (const [kind, method, cap] of [
      ['invite', 'sendInvite', 100],
      ['message', 'sendMessage', 150],
      ['view_profile', 'viewProfile', 250],
    ] as const) {
      const e = setup()
      const user = addUser(e.db)
      const big = { dailyInvites: 200, dailyMessages: 300, dailyProfileViews: 300 }
      const c = addCampaign(e.db, user, { sequence: linear(kind, { kind: 'follow', delay: { min: 1, max: 1, unit: 'days' } }), settings: big })
      const [l] = addLeads(e.db, user, c, ['cap-x'])
      const other = addCampaign(e.db, user, { sequence: linear(kind), settings: big })
      addSuccesses(e.db, user, other, kind, cap - 1, T0 - HOUR)
      await e.engine.tick()
      assert.equal(e.li.callsOf(method).length, 1, `${kind} below the cap`)
      const [y] = addLeads(e.db, user, c, ['cap-y'])
      await e.tickAfterGap()
      assert.equal(e.li.callsOf(method).length, 1, `${kind} at the cap`)
      assert.equal(getLead(e.db, y).next_action_at, THU_9)
      assert.notEqual(getLead(e.db, l).status, 'queued')
    }
  })

  it('a limit of 0 never runs that step', async () => {
    const { e, leads } = invites(1, { dailyInvites: 0 })
    await e.engine.tick()
    assert.equal(e.li.calls.length, 0)
    assert.equal(getLead(e.db, leads[0]).next_action_at, THU_9)
  })

  it('postpones over the weekend to Monday', async () => {
    const { e, user, a, leads } = invites(1, { dailyInvites: 1 })
    const fri = Date.parse('2026-10-09T15:00:00Z')
    e.setNow(fri)
    run(e.db, 'UPDATE leads SET next_action_at = ?, step_started_at = ? WHERE id = ?', fri, fri, leads[0])
    addSuccesses(e.db, user, a, 'invite', 1, fri - HOUR)
    await e.engine.tick()
    assert.equal(getLead(e.db, leads[0]).next_action_at, Date.parse('2026-10-12T09:00:00Z'))
  })
})

describe('engine: search imports', () => {
  function withImport(opts: Parameters<typeof addImport>[3] = {}, campaignOpts: { skipOtherCampaigns?: boolean } = {}) {
    const e = setup()
    const user = addUser(e.db)
    const campaign = addCampaign(e.db, user, {
      sequence: linear({ kind: 'view_profile', delay: { min: 1, max: 5, unit: 'minutes' } }),
      settings: campaignOpts,
      name: 'Imports',
    })
    const imp = addImport(e.db, user, campaign, opts)
    return { e, user, campaign, imp }
  }

  it('runs before due leads and pages through results until there are no more', async () => {
    const { e, user, campaign, imp } = withImport({ max: 10 })
    const [old] = addLeads(e.db, user, campaign, ['existing-lead'])
    e.li.queue('searchPeople', { people: [person('ann-1', 'Ann', 'One'), person('bob-2', 'Bob', 'Two')], hasMore: true })
    e.li.queue('searchPeople', { people: [person('cid-3', 'Cid', 'Three')], hasMore: false })

    await e.engine.tick()
    assert.deepEqual(e.li.calls.map((c) => [c.method, c.args[1]]), [['searchPeople', 1]])
    let i = getImport(e.db, imp)
    assert.deepEqual([i.status, i.page, i.collected, i.attempts], ['running', 2, 2, 0])
    const ann = all<{ first_name: string; last_name: string; headline: string; location: string; list_name: string; status: string; current_step_id: string; next_action_at: number }>(
      e.db,
      `SELECT * FROM leads WHERE public_id = 'ann-1'`,
    )[0]
    assert.deepEqual(
      [ann.first_name, ann.last_name, ann.headline, ann.location, ann.list_name, ann.status, ann.current_step_id, ann.next_action_at],
      ['Ann', 'One', 'Engineer', 'Pune', 'Founders', 'queued', 's1', T0 + 3 * MIN],
    )
    assert.deepEqual(activities(e.db, user).map((a) => [a.type, a.status, a.detail, a.campaign_name]), [['import', 'success', 'Collected 2 leads (page 1)', 'Imports']])

    await e.tickAfterGap()
    i = getImport(e.db, imp)
    assert.deepEqual([i.status, i.page, i.collected], ['done', 3, 3])
    assert.equal(e.li.callsOf('searchPeople')[1].args[1], 2)

    await e.tickAfterGap()
    assert.equal(e.li.calls.at(-1)!.method, 'viewProfile')
    assert.equal(getLead(e.db, old).status, 'finished')
  })

  it('stops at max leads (dropping the rest of the page)', async () => {
    const { e, imp, campaign } = withImport({ max: 3 })
    e.li.queue('searchPeople', { people: ['a-1', 'b-2', 'c-3', 'd-4', 'e-5'].map((id) => person(id)), hasMore: true })
    await e.engine.tick()
    const i = getImport(e.db, imp)
    assert.deepEqual([i.status, i.collected], ['done', 3])
    assert.equal(all(e.db, 'SELECT id FROM leads WHERE campaign_id = ?', campaign).length, 3)
  })

  it('does not count duplicates and keeps filling from the same page', async () => {
    const { e, user, campaign, imp } = withImport({ max: 3 })
    addLeads(e.db, user, campaign, ['dup-1'])
    e.li.queue('searchPeople', {
      people: [person('dup-1'), person('new-2'), person('new-2'), { ...person('bad'), profileUrl: 'not a url' }, person('new-3'), person('new-4'), person('new-5')],
      hasMore: true,
    })
    await e.engine.tick()
    const i = getImport(e.db, imp)
    assert.deepEqual([i.collected, i.status], [3, 'done'])
    const ids = all<{ public_id: string }>(e.db, 'SELECT public_id FROM leads WHERE campaign_id = ? ORDER BY rowid', campaign).map((r) => r.public_id)
    assert.deepEqual(ids, ['dup-1', 'new-2', 'new-3', 'new-4'])
    assert.equal(activities(e.db, user)[0].detail, 'Collected 3 leads (page 1)')
  })

  it('stores people already in another active campaign as skipped (skipOtherCampaigns) without counting them', async () => {
    const { e, user, imp } = withImport({ max: 5 }, { skipOtherCampaigns: true })
    const other = addCampaign(e.db, user, { sequence: linear('follow') })
    addLeads(e.db, user, other, ['taken-1'])
    e.li.queue('searchPeople', { people: [person('taken-1'), person('free-2')], hasMore: false })
    await e.engine.tick()
    assert.equal(getImport(e.db, imp).collected, 1)
    const taken = all<{ status: string }>(e.db, `SELECT status FROM leads WHERE public_id = 'taken-1' AND campaign_id <> ?`, other)[0]
    assert.equal(taken.status, 'skipped')
  })

  it('transient search errors cost no attempt; the user backs off and leads go first for a while', async () => {
    const { e, user, campaign, imp } = withImport()
    const [l] = addLeads(e.db, user, campaign, ['waiting-1'])
    e.li.queue('searchPeople', linkedInError('transient', 'Could not start the browser'))
    await e.engine.tick()
    assert.deepEqual([getImport(e.db, imp).attempts, getImport(e.db, imp).status, getImport(e.db, imp).error], [0, 'pending', null])
    assert.equal(account(e.db, user).next_action_at, T0 + 15 * MIN)
    assert.deepEqual(activities(e.db, user).map((a) => [a.type, a.status, a.detail]), [['session', 'failed', 'Could not start the browser']])
    await e.tickAfterGap()
    assert.equal(e.li.calls.at(-1)!.method, 'viewProfile')
    assert.equal(getLead(e.db, l).status, 'finished')
    e.advance(30 * MIN)
    await e.tickAfterGap()
    assert.equal(e.li.calls.at(-1)!.method, 'searchPeople')
    assert.equal(getImport(e.db, imp).status, 'done')
  })

  it('account_problem during a search: account error, the import is not penalised', async () => {
    const { e, user, imp } = withImport()
    e.li.queue('searchPeople', linkedInError('account_problem', 'LinkedIn restricted your account'))
    await e.engine.tick()
    assert.deepEqual([account(e.db, user).status, account(e.db, user).last_error], ['error', 'LinkedIn restricted your account'])
    assert.deepEqual([getImport(e.db, imp).attempts, getImport(e.db, imp).status], [0, 'pending'])
    assert.deepEqual(activities(e.db, user).map((a) => [a.type, a.status]), [['session', 'failed']])
    await e.tickAfterGap()
    assert.equal(e.li.sessions.length, 1)
  })

  it('stops after page 100', async () => {
    const { e, imp } = withImport({ page: 100, max: 1000 })
    e.li.queue('searchPeople', { people: [person('last-1')], hasMore: true })
    await e.engine.tick()
    assert.deepEqual([getImport(e.db, imp).status, getImport(e.db, imp).page], ['done', 101])
  })

  it('processes the oldest open import of an active campaign first', async () => {
    const e = setup()
    const user = addUser(e.db)
    const paused = addCampaign(e.db, user, { sequence: linear('view_profile'), status: 'paused' })
    addImport(e.db, user, paused, { createdAt: T0 - 2 * DAY })
    const c = addCampaign(e.db, user, { sequence: linear('view_profile') })
    const newer = addImport(e.db, user, c, { createdAt: T0 - DAY, url: 'https://www.linkedin.com/search/results/people/?keywords=newer' })
    const older = addImport(e.db, user, c, { createdAt: T0 - 2 * DAY, url: 'https://www.linkedin.com/search/results/people/?keywords=older' })
    await e.engine.tick()
    assert.equal(e.li.calls[0].args[0], 'https://www.linkedin.com/search/results/people/?keywords=older')
    assert.equal(getImport(e.db, older).status, 'done')
    assert.equal(getImport(e.db, newer).status, 'pending')
  })

  it('fails after 3 errors; session_expired does not count', async () => {
    const { e, user, imp } = withImport()
    e.li.queue('searchPeople', linkedInError('unknown', 'Search page did not load'))
    await e.engine.tick()
    assert.deepEqual([getImport(e.db, imp).attempts, getImport(e.db, imp).status, getImport(e.db, imp).error], [1, 'pending', 'Search page did not load'])

    e.li.queue('searchPeople', linkedInError('session_expired', 'Signed out'))
    await e.tickAfterGap()
    assert.equal(getImport(e.db, imp).attempts, 1)
    assert.equal(account(e.db, user).status, 'expired')
    run(e.db, `UPDATE linkedin_accounts SET status = 'connected' WHERE user_id = ?`, user)

    e.li.queue('searchPeople', new Error('net::ERR_CONNECTION_RESET'), linkedInError('not_found', 'gone'))
    await e.tickAfterGap()
    await e.tickAfterGap()
    const i = getImport(e.db, imp)
    assert.deepEqual([i.attempts, i.status, i.error], [3, 'failed', 'gone'])
    assert.deepEqual(
      activities(e.db, user).map((a) => [a.type, a.status]),
      [
        ['import', 'failed'],
        ['session', 'failed'],
        ['import', 'failed'],
        ['import', 'failed'],
      ],
    )
  })

  it('a rate-limited search lets leads run until the next day', async () => {
    const { e, user, campaign, imp } = withImport()
    const [l] = addLeads(e.db, user, campaign, ['waiting-1'])
    e.li.queue('searchPeople', linkedInError('rate_limited', 'Commercial use limit'))
    await e.engine.tick()
    assert.equal(getImport(e.db, imp).attempts, 1)
    await e.tickAfterGap()
    assert.equal(e.li.calls.at(-1)!.method, 'viewProfile')
    assert.equal(getLead(e.db, l).status, 'finished')
    assert.equal(e.engine.nextActionAt(user), THU_9)
    e.setNow(THU_9)
    await e.engine.tick()
    assert.equal(e.li.calls.at(-1)!.method, 'searchPeople')
  })

  it('discards a page whose import was removed meanwhile', async () => {
    const { e, campaign, imp } = withImport()
    const d = deferred<unknown>()
    e.li.queue('searchPeople', d.promise)
    const t = e.engine.tick()
    await until(() => e.li.calls.length === 1)
    run(e.db, 'DELETE FROM lead_imports WHERE id = ?', imp)
    d.resolve({ people: [person('late-1')], hasMore: false })
    await t
    assert.equal(all(e.db, 'SELECT id FROM leads WHERE campaign_id = ?', campaign).length, 0)
    assert.deepEqual(e.errors, [])
  })
})

describe('engine: skipOtherCampaigns', () => {
  const statusOf = (e: ReturnType<typeof setup>, campaign: string, publicId: string) => ({
    ...all<{ status: string; error: string | null; current_step_id: string | null; next_action_at: number | null }>(
      e.db,
      'SELECT status, error, current_step_id, next_action_at FROM leads WHERE campaign_id = ? AND public_id = ?',
      campaign,
      publicId,
    )[0],
  })

  it('at insert: a person still in progress in another active, paused or draft campaign is skipped', () => {
    for (const status of ['active', 'paused', 'draft'] as const) {
      const e = setup()
      const user = addUser(e.db)
      const a = addCampaign(e.db, user, { sequence: linear('invite'), status, name: 'Campaign A' })
      addLeads(e.db, user, a, ['jane-doe'])
      const b = addCampaign(e.db, user, { sequence: linear('invite'), status: 'draft', settings: { skipOtherCampaigns: true }, name: 'B' })
      addLeads(e.db, user, b, ['jane-doe'])
      assert.deepEqual(statusOf(e, b, 'jane-doe'), { status: 'skipped', error: 'Already in campaign “Campaign A”', current_step_id: null, next_action_at: null }, status)
    }
  })

  it('at insert: finished / skipped / failed leads, completed campaigns, other users and the setting off do not count', () => {
    const e = setup()
    const user = addUser(e.db)
    const done = addCampaign(e.db, user, { sequence: linear('invite'), name: 'Done' })
    addLeads(e.db, user, done, ['fin-1', 'skp-2', 'fail-3'])
    run(e.db, `UPDATE leads SET status = CASE public_id WHEN 'fin-1' THEN 'finished' WHEN 'skp-2' THEN 'skipped' ELSE 'failed' END WHERE campaign_id = ?`, done)
    const completed = addCampaign(e.db, user, { sequence: linear('invite'), status: 'completed', name: 'Completed' })
    addLeads(e.db, user, completed, ['comp-4'])
    const otherUser = addUser(e.db)
    addLeads(e.db, otherUser, addCampaign(e.db, otherUser, { sequence: linear('invite') }), ['theirs-5'])
    const b = addCampaign(e.db, user, { sequence: linear('invite'), settings: { skipOtherCampaigns: true }, name: 'B' })
    addLeads(e.db, user, b, ['fin-1', 'skp-2', 'fail-3', 'comp-4', 'theirs-5'])
    for (const id of ['fin-1', 'skp-2', 'fail-3', 'comp-4', 'theirs-5']) assert.equal(statusOf(e, b, id).status, 'queued', id)
    const off = addCampaign(e.db, user, { sequence: linear('invite'), settings: { skipOtherCampaigns: false }, name: 'Off' })
    addLeads(e.db, user, off, ['comp-4', 'fin-1'])
    addLeads(e.db, user, addCampaign(e.db, user, { sequence: linear('invite'), name: 'C' }), ['dup-6'])
    addLeads(e.db, user, off, ['dup-6'])
    assert.equal(statusOf(e, off, 'dup-6').status, 'queued')
  })

  it('two drafts that slipped past the insert check, both started: only the first campaign to act contacts the person', async () => {
    const e = setup()
    const user = addUser(e.db)
    // B is created first; A, created later with the setting off, does not check B at insert.
    const b = addCampaign(e.db, user, { sequence: linear('view_profile'), status: 'draft', name: 'B', settings: { skipOtherCampaigns: true } })
    const [lb] = addLeads(e.db, user, b, [person('jane-doe', 'Janet', 'Doe')], T0 + 1000)
    const a = addCampaign(e.db, user, {
      sequence: linear('message', { kind: 'follow', delay: { min: 1, max: 1, unit: 'days' } }),
      status: 'draft',
      name: 'A',
      settings: { skipOtherCampaigns: false },
    })
    const [la] = addLeads(e.db, user, a, [person('jane-doe', 'Janet', 'Doe')])
    assert.deepEqual([getLead(e.db, la).status, getLead(e.db, lb).status], ['queued', 'queued'])
    run(e.db, `UPDATE campaigns SET status = 'active'`)
    e.setNow(T0 + 2000)

    await e.engine.tick() // A's lead is the most overdue: A messages Jane
    await e.tickAfterGap() // B's lead: A is already contacting Jane → skipped, no LinkedIn call
    await e.tickAfterGap()
    assert.deepEqual(e.li.calls.map((c) => [c.method, c.args[0]]), [['sendMessage', profile('jane-doe')]])
    assert.equal(getLead(e.db, la).current_step_id, 's2')
    const l = getLead(e.db, lb)
    assert.deepEqual([l.status, l.error], ['skipped', 'Already being contacted by campaign “A”'])
  })

  it('before the first action: a lead another active or paused campaign is already contacting is skipped without LinkedIn', async () => {
    for (const otherStatus of ['active', 'paused'] as const) {
      const e = setup()
      const user = addUser(e.db)
      const a = addCampaign(e.db, user, { sequence: linear('invite', { kind: 'message', delay: { min: 3, max: 3, unit: 'days' } }), name: 'Campaign A' })
      const [la] = addLeads(e.db, user, a, ['jane-doe'])
      const b = addCampaign(e.db, user, { sequence: linear('view_profile'), status: 'draft', name: 'B', settings: { skipOtherCampaigns: false } })
      const [lb] = addLeads(e.db, user, b, ['jane-doe'], T0 + 1000)
      run(e.db, `UPDATE campaigns SET settings_json = json_set(settings_json, '$.skipOtherCampaigns', json('true')) WHERE id = ?`, b)

      await e.engine.tick() // A invites Jane
      assert.equal(getLead(e.db, la).status, 'invited')
      run(e.db, `UPDATE campaigns SET status = ? WHERE id = ?`, otherStatus, a)
      run(e.db, `UPDATE campaigns SET status = 'active' WHERE id = ?`, b)
      await e.tickAfterGap()
      assert.deepEqual(e.li.calls.map((c) => c.method), ['sendInvite'], otherStatus)
      const l = getLead(e.db, lb)
      assert.deepEqual(
        [l.status, l.error, l.last_action, l.last_action_at, l.current_step_id, l.next_action_at],
        ['skipped', 'Already being contacted by campaign “Campaign A”', 'Skipped', null, null, null],
      )
      const last = activities(e.db, user).at(-1)!
      assert.deepEqual(
        [last.type, last.status, last.detail, last.campaign_id, last.lead_id],
        ['view_profile', 'skipped', 'Already being contacted by campaign “Campaign A”', b, lb],
      )
      assert.equal(campaignStatus(e.db, b), 'completed')
    }
  })

  it('before the first action: the setting off, a lead already acted on, or a finished lead elsewhere → it runs', async () => {
    const e = setup()
    const user = addUser(e.db)
    const a = addCampaign(e.db, user, { sequence: linear('follow'), name: 'A' })
    const [, , la3] = addLeads(e.db, user, a, ['p-one', 'p-two', 'p-three'], T0 - HOUR)
    run(e.db, `UPDATE leads SET last_action_at = ?, next_action_at = ? WHERE campaign_id = ?`, T0 - HOUR, T0 + DAY, a)
    run(e.db, `UPDATE leads SET status = 'finished', next_action_at = NULL WHERE id = ?`, la3)
    const off = addCampaign(e.db, user, { sequence: linear('view_profile'), name: 'Off' })
    const [lOff] = addLeads(e.db, user, off, ['p-one'])
    const on = addCampaign(e.db, user, { sequence: linear('view_profile', 'view_profile'), name: 'On', settings: { skipOtherCampaigns: false } })
    const [lActed, lFree] = addLeads(e.db, user, on, ['p-two', 'p-three'], T0 + 1000)
    run(e.db, `UPDATE campaigns SET settings_json = json_set(settings_json, '$.skipOtherCampaigns', json('true')) WHERE id = ?`, on)
    run(e.db, `UPDATE leads SET last_action_at = ? WHERE id = ?`, T0 - MIN, lActed)
    e.setNow(T0 + 2000)
    for (let i = 0; i < 3; i++) await e.tickAfterGap()
    assert.equal(getLead(e.db, lOff).status, 'finished')
    assert.notEqual(getLead(e.db, lActed).status, 'skipped')
    assert.notEqual(getLead(e.db, lFree).status, 'skipped')
    assert.equal(e.li.callsOf('viewProfile').length, 3)
  })
})

describe('engine: campaign completion', () => {
  it('completes an active campaign once nothing is scheduled', async () => {
    const e = setup()
    const user = addUser(e.db)
    const done = addCampaign(e.db, user, { sequence: linear('view_profile') })
    addLeads(e.db, user, done, ['only-one'])
    const busy = addCampaign(e.db, user, { sequence: linear('view_profile'), name: 'busy' })
    addLeads(e.db, user, busy, ['later-one'], T0 + HOUR)
    const empty = addCampaign(e.db, user, { sequence: linear('view_profile'), name: 'empty' })
    await e.engine.tick()
    assert.equal(campaignStatus(e.db, done), 'completed')
    assert.equal(campaignStatus(e.db, busy), 'active')
    assert.equal(campaignStatus(e.db, empty), 'active')
    assert.ok(e.logs.some((l) => l.includes('campaign "Campaign" completed')))
  })

  it('waits for open imports before completing', async () => {
    const e = setup()
    const user = addUser(e.db)
    const c = addCampaign(e.db, user, { sequence: linear('view_profile'), name: 'importing' })
    addLeads(e.db, user, c, ['imp-lead'])
    run(e.db, `UPDATE leads SET status = 'finished', next_action_at = NULL WHERE campaign_id = ?`, c)
    addImport(e.db, user, c)
    e.li.queue('searchPeople', { people: [], hasMore: true })
    await e.engine.tick()
    assert.equal(campaignStatus(e.db, c), 'active')
    await e.tickAfterGap() // last page: import done
    assert.equal(campaignStatus(e.db, c), 'completed')
  })

  it('completes campaigns whose leads were all failed or skipped', async () => {
    const { e, campaign, leads } = basic(1)
    e.li.queue('viewProfile', linkedInError('not_found', 'x'))
    await e.engine.tick()
    assert.equal(getLead(e.db, leads[0]).status, 'failed')
    assert.equal(campaignStatus(e.db, campaign), 'completed')
  })
})

describe('engine: nextActionAt', () => {
  it('is null without a connected account, an active campaign or scheduled work', () => {
    const a = basic(1, { linkedin: 'expired' })
    assert.equal(a.e.engine.nextActionAt(a.user), null)
    const b = basic(1)
    run(b.e.db, `UPDATE campaigns SET status = 'paused'`)
    assert.equal(b.e.engine.nextActionAt(b.user), null)
    const c = basic(1)
    run(c.e.db, `UPDATE leads SET status = 'finished', next_action_at = NULL`)
    assert.equal(c.e.engine.nextActionAt(c.user), null)
    const d = basic(0)
    assert.equal(d.e.engine.nextActionAt(d.user), null)
    assert.equal(d.e.engine.nextActionAt('usr_unknown'), null)
  })

  it('due work → now, or the end of the gap', async () => {
    const { e, user } = basic(2)
    assert.equal(e.engine.nextActionAt(user), T0)
    await e.engine.tick()
    assert.equal(e.engine.nextActionAt(user), T0 + 3 * MIN)
  })

  it('future work → its due time (or the gap if later), moved into active hours', () => {
    const { e, user, leads } = basic(1)
    run(e.db, 'UPDATE leads SET next_action_at = ? WHERE id = ?', T0 + 2 * HOUR, leads[0])
    assert.equal(e.engine.nextActionAt(user), T0 + 2 * HOUR)
    run(e.db, 'UPDATE linkedin_accounts SET next_action_at = ? WHERE user_id = ?', T0 + 3 * HOUR, user)
    assert.equal(e.engine.nextActionAt(user), T0 + 3 * HOUR)
    run(e.db, 'UPDATE leads SET next_action_at = ? WHERE id = ?', T0 + 10 * HOUR, leads[0]) // 20:00 UTC
    assert.equal(e.engine.nextActionAt(user), THU_9)
    e.setNow(SAT)
    run(e.db, 'UPDATE leads SET next_action_at = ? WHERE id = ?', SAT - HOUR, leads[0])
    assert.equal(e.engine.nextActionAt(user), Date.parse('2026-10-12T09:00:00Z'))
  })

  it('an open import counts as due work', () => {
    const e = setup()
    const user = addUser(e.db)
    addImport(e.db, user, addCampaign(e.db, user, { sequence: linear('view_profile') }))
    assert.equal(e.engine.nextActionAt(user), T0)
  })
})

describe('engine: sequence edits (reconcileLeads)', () => {
  it('moves never-acted leads to the new root and finishes the others', () => {
    const e = setup()
    const user = addUser(e.db)
    const c = addCampaign(e.db, user, { sequence: linear('view_profile', 'invite', 'message') })
    const [fresh, acted, replied, kept, done] = addLeads(e.db, user, c, ['fresh-a', 'acted-b', 'replied-c', 'kept-d', 'done-e'])
    run(e.db, `UPDATE leads SET current_step_id = 's2', last_action_at = ?, status = 'in_progress' WHERE id = ?`, T0, acted)
    run(e.db, `UPDATE leads SET current_step_id = 's2', last_action_at = ?, status = 'replied' WHERE id = ?`, T0, replied)
    run(e.db, `UPDATE leads SET current_step_id = 's3' WHERE id = ?`, kept)
    run(e.db, `UPDATE leads SET status = 'finished', current_step_id = 's2', next_action_at = NULL WHERE id = ?`, done)

    const edited = tree(
      { id: 'n1', kind: 'follow', delay: { min: 1, max: 5, unit: 'minutes' }, next: 's3' },
      { id: 's3', kind: 'message', config: { message: 'Hi' } },
    )
    reconcileLeads(e.db, c, edited, T0 + HOUR, () => 0.5)
    const at = T0 + HOUR + 3 * MIN
    assert.deepEqual(pickL(getLead(e.db, fresh)), { current_step_id: 'n1', next_action_at: at, step_started_at: at, status: 'queued' })
    assert.deepEqual(pickL(getLead(e.db, acted)), { current_step_id: null, next_action_at: null, step_started_at: T0, status: 'finished' })
    assert.equal(getLead(e.db, replied).status, 'replied')
    assert.equal(getLead(e.db, replied).next_action_at, null)
    assert.equal(getLead(e.db, kept).current_step_id, 's3')
    assert.equal(getLead(e.db, done).current_step_id, 's2')

    reconcileLeads(e.db, c, { rootId: null, steps: {} }, T0 + HOUR)
    assert.deepEqual(pickL(getLead(e.db, fresh)), { current_step_id: null, next_action_at: null, step_started_at: null, status: 'queued' })
  })

  it('the engine re-schedules a lead whose step disappeared and runs it in the same tick', async () => {
    const { e, leads } = basic(1)
    run(e.db, `UPDATE leads SET current_step_id = 'gone' WHERE id = ?`, leads[0])
    await e.engine.tick()
    assert.equal(e.li.calls[0].method, 'viewProfile')
    assert.equal(getLead(e.db, leads[0]).current_step_id, 's2')
  })
})

const pickL = (l: { current_step_id: string | null; next_action_at: number | null; step_started_at: number | null; status: string }) => ({
  current_step_id: l.current_step_id,
  next_action_at: l.next_action_at,
  step_started_at: l.step_started_at,
  status: l.status,
})

describe('engine: timing helpers', () => {
  it('nextDayWindow / recheckAt / retryAt', () => {
    assert.equal(nextDayWindow(T0, UTC_HOURS), THU_9)
    assert.equal(nextDayWindow(Date.parse('2026-10-07T00:00:00Z'), UTC_HOURS), THU_9)
    assert.equal(nextDayWindow(T0, DEFAULT_SETTINGS), Date.parse('2026-10-08T03:30:00Z'))
    assert.equal(nextDayWindow(T0, { ...UTC_HOURS, activeDays: [] }), Date.parse('2026-10-08T00:00:00Z'))
    assert.equal(recheckAt(T0, T0, 30 * DAY, () => 1), T0 + 4.8 * HOUR)
    assert.equal(recheckAt(T0, T0, 3 * HOUR, () => 0.5), T0 + 30 * MIN)
    assert.equal(retryAt(T0, 2, () => 0), T0 + 30 * MIN)
    assert.equal(retryAt(T0, 1, () => 1), T0 + 30 * MIN)
  })

  it('createEngine works with the default clock and rand', async () => {
    const e = setup()
    const engine = createEngine({ db: e.db, linkedin: new FakeLinkedIn(), tickMs: 15_000, log: () => {} })
    await engine.tick()
    assert.equal(engine.nextActionAt('nobody'), null)
  })
})
