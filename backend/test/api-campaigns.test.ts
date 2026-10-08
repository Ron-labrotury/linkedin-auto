import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { all, one, run } from '../src/db/index.ts'
import { transitionError } from '../src/routes/campaigns.ts'
import { type TestApi, SETTINGS, campaignInput, emptySeq, profile, sampleSequence, startApi } from './helpers/api-server.ts'

const SEARCH = 'https://www.linkedin.com/search/results/people/?keywords=founder'

function insertActivity(api: TestApi, a: { userId: string; campaignId: string | null; type: string; status: string; at?: number; leadId?: string }) {
  run(
    api.db,
    `INSERT INTO activities (id, user_id, campaign_id, campaign_name, lead_id, lead_name, step_id, type, status, detail, created_at)
     VALUES (?, ?, ?, 'C', ?, 'L', NULL, ?, ?, '', ?)`,
    `act_${Math.random().toString(36).slice(2)}`,
    a.userId,
    a.campaignId,
    a.leadId ?? null,
    a.type,
    a.status,
    a.at ?? Date.now(),
  )
}

describe('campaigns API', () => {
  let api: TestApi
  let token: string
  let userId: string
  before(async () => {
    api = await startApi()
    const s = await api.signup()
    token = s.token
    userId = s.user.id
  })
  after(() => api.close())

  // leads repeat across tests, so "skip leads in other active campaigns" is off unless a test turns it on
  const SETTINGS_NO_SKIP = { ...SETTINGS, skipOtherCampaigns: false }
  const create = (over: Record<string, unknown> = {}) =>
    api.call('POST', '/api/campaigns', { token, body: campaignInput({ settings: SETTINGS_NO_SKIP, ...over }) })

  describe('create', () => {
    it('creates a draft with leads (normalized, deduped) and search imports', async () => {
      const res = await create({
        leads: [
          { profileUrl: 'https://linkedin.com/in/Ada-Lovelace?trk=x', firstName: 'Ada', company: 'Engines Ltd', listName: 'Pioneers' },
          { profileUrl: profile('ada-lovelace') },
          { profileUrl: 'not a url' },
          { profileUrl: profile('alan-turing'), headline: null },
        ],
        searchImports: [{ url: SEARCH, max: 150, listName: 'Founders' }],
      })
      assert.equal(res.status, 201)
      const c = res.body
      assert.match(c.id, /^cmp_/)
      assert.equal(c.status, 'draft')
      assert.equal(c.stepCount, 4)
      assert.equal(c.pendingImports, 1)
      assert.equal(c.stats.totalLeads, 2)
      assert.deepEqual(c.settings, SETTINGS_NO_SKIP)
      assert.deepEqual(c.sequence, sampleSequence())
      assert.equal(c.imports.length, 1)
      assert.deepEqual(
        { url: c.imports[0].url, max: c.imports[0].max, status: c.imports[0].status, listName: c.imports[0].listName, collected: 0 },
        { url: SEARCH, max: 150, status: 'pending', listName: 'Founders', collected: c.imports[0].collected },
      )

      const leads = all<{ profile_url: string; first_name: string; status: string; current_step_id: string; next_action_at: number; list_name: string }>(
        api.db,
        'SELECT * FROM leads WHERE campaign_id = ? ORDER BY rowid',
        c.id,
      )
      assert.equal(leads.length, 2)
      assert.equal(leads[0].profile_url, 'https://www.linkedin.com/in/ada-lovelace/')
      assert.equal(leads[0].first_name, 'Ada')
      assert.equal(leads[0].list_name, 'Pioneers')
      assert.equal(leads[0].status, 'queued')
      assert.equal(leads[0].current_step_id, 's1')
      const delay = leads[0].next_action_at - Date.now()
      assert.ok(delay > 0 && delay <= 5 * 60_000 + 1000, 'first step is due in 1–5 min')
    })

    it('rejects invalid input with field details', async () => {
      const res = await create({
        name: '',
        settings: { ...SETTINGS, dailyInvites: 201, dailyMessages: -1, dailyProfileViews: 1.5 },
        searchImports: [{ url: 'https://www.linkedin.com/in/someone/', max: 0 }],
      })
      assert.equal(res.status, 400)
      const d = res.body.details
      assert.ok(d.name)
      assert.ok(d['settings.dailyInvites'])
      assert.ok(d['settings.dailyMessages'])
      assert.ok(d['settings.dailyProfileViews'])
      assert.ok(d['searchImports.0.url'])
      assert.ok(d['searchImports.0.max'])

      assert.equal((await create({ name: 'x'.repeat(81) })).status, 400)
      assert.equal((await create({ settings: { ...SETTINGS, stopOnReply: 'yes' } })).status, 400)
      const noSettings = await create({ settings: undefined })
      assert.equal(noSettings.status, 400)
      assert.equal(noSettings.body.details.settings, 'Campaign settings are required')
      const big = await create({ leads: Array.from({ length: 5001 }, (_, i) => ({ profileUrl: profile(`p-${i}`) })) })
      assert.equal(big.status, 400)
      assert.ok(big.body.details.leads)
      assert.equal(one<{ n: number }>(api.db, `SELECT COUNT(*) AS n FROM campaigns WHERE name = ''`)!.n, 0)
    })

    it('validates the sequence with validateSequence → details.sequence', async () => {
      const seq = sampleSequence()
      seq.steps.s2.config.message = '   '
      const res = await create({ sequence: seq })
      assert.equal(res.status, 400)
      assert.equal(res.body.details.sequence, 'Send message: message is empty')
      assert.equal(res.body.error, 'Send message: message is empty')

      const loop = sampleSequence() as any
      loop.steps.s5.next = 's1'
      assert.equal((await create({ sequence: loop })).body.details.sequence, 'Sequence contains a loop or a step with two parents')

      const malformed = await create({ sequence: { rootId: 's1', steps: { s1: null } } })
      assert.equal(malformed.status, 400)
      assert.equal(malformed.body.details.sequence, 'Sequence is malformed')

      const missing = await create({ sequence: undefined })
      assert.equal(missing.status, 400)
      assert.ok(missing.body.details.sequence)

      const longNote = sampleSequence()
      longNote.steps.s1.config.message = 'x'.repeat(301)
      assert.match((await create({ sequence: longNote })).body.details.sequence, /300/)
    })

    it('strips unknown fields from stored sequences', async () => {
      const seq = sampleSequence() as any
      seq.steps.s1.evil = '<script>'
      seq.steps.s1.config.extra = 1
      const res = await create({ sequence: seq })
      assert.equal(res.status, 201)
      assert.equal(res.body.sequence.steps.s1.evil, undefined)
      assert.equal(res.body.sequence.steps.s1.config.extra, undefined)
    })

    it('active requires steps and leads (422), and nothing is stored on failure', async () => {
      const before = one<{ n: number }>(api.db, 'SELECT COUNT(*) AS n FROM campaigns')!.n
      const noSteps = await create({ status: 'active', sequence: emptySeq() })
      assert.equal(noSteps.status, 422)
      const noLeads = await create({ status: 'active', leads: [] })
      assert.equal(noLeads.status, 422)
      const invalidOnly = await create({ status: 'active', leads: [{ profileUrl: 'nope' }] })
      assert.equal(invalidOnly.status, 422)
      assert.equal(one<{ n: number }>(api.db, 'SELECT COUNT(*) AS n FROM campaigns')!.n, before)

      const withImport = await create({ status: 'active', leads: [], searchImports: [{ url: SEARCH, max: 10 }] })
      assert.equal(withImport.status, 201)
      assert.equal(withImport.body.status, 'active')
      const withLeads = await create({ status: 'active' })
      assert.equal(withLeads.status, 201)
    })

    it('a draft may have an empty sequence', async () => {
      const res = await create({ sequence: emptySeq() })
      assert.equal(res.status, 201)
      assert.equal(res.body.stepCount, 0)
      const lead = one<{ current_step_id: string | null; next_action_at: number | null }>(api.db, 'SELECT * FROM leads WHERE campaign_id = ?', res.body.id)!
      assert.equal(lead.current_step_id, null)
      assert.equal(lead.next_action_at, null)
    })
  })

  describe('read', () => {
    it('lists newest first and gets one', async () => {
      const a = (await create({ name: 'First' })).body
      const b = (await create({ name: 'Second' })).body
      run(api.db, 'UPDATE campaigns SET created_at = created_at - 1000 WHERE id = ?', a.id)
      const list = await api.call('GET', '/api/campaigns', { token })
      assert.equal(list.status, 200)
      const ids = list.body.map((c: any) => c.id)
      assert.ok(ids.indexOf(b.id) < ids.indexOf(a.id))
      const summary = list.body.find((c: any) => c.id === b.id)
      assert.equal(summary.sequence, undefined, 'summaries have no sequence')
      assert.deepEqual(Object.keys(summary).sort(), ['createdAt', 'id', 'name', 'pendingImports', 'stats', 'status', 'stepCount', 'updatedAt'])

      const one_ = await api.call('GET', `/api/campaigns/${a.id}`, { token })
      assert.equal(one_.status, 200)
      assert.equal(one_.body.name, 'First')
      assert.equal((await api.call('GET', '/api/campaigns/cmp_missing', { token })).status, 404)
    })

    it('computes stats as documented', async () => {
      const c = (
        await create({
          leads: ['a-a', 'b-b', 'c-c', 'd-d', 'e-e'].map((id) => ({ profileUrl: profile(id) })),
        })
      ).body
      const ids = all<{ id: string; public_id: string }>(api.db, 'SELECT id, public_id FROM leads WHERE campaign_id = ?', c.id)
      const lead = (p: string) => ids.find((l) => l.public_id === p)!.id
      const t = Date.now()
      run(api.db, `UPDATE leads SET last_action_at = ?, invited_at = ?, status = 'invited' WHERE id = ?`, t, t, lead('a-a'))
      run(api.db, `UPDATE leads SET last_action_at = ?, invited_at = ?, connected_at = ?, status = 'connected' WHERE id = ?`, t, t, t, lead('b-b'))
      run(api.db, `UPDATE leads SET last_action_at = ?, invited_at = ?, connected_at = ?, replied_at = ?, status = 'replied' WHERE id = ?`, t, t, t, t, lead('c-c'))
      run(api.db, `UPDATE leads SET last_action_at = ?, connected_at = ?, status = 'failed' WHERE id = ?`, t, t, lead('d-d'))
      // contacted = leads with a successful LinkedIn action: a-a (invite), b-b (message), c-c (follow)
      insertActivity(api, { userId, campaignId: c.id, type: 'invite', status: 'success', leadId: lead('a-a') })
      insertActivity(api, { userId, campaignId: c.id, type: 'view_profile', status: 'success', leadId: lead('a-a') })
      insertActivity(api, { userId, campaignId: c.id, type: 'message', status: 'success', leadId: lead('b-b') })
      insertActivity(api, { userId, campaignId: c.id, type: 'message', status: 'success', leadId: lead('b-b') })
      insertActivity(api, { userId, campaignId: c.id, type: 'follow', status: 'success', leadId: lead('c-c') })
      // d-d: only a skipped step, a failed step, an evaluated condition and a detection – not contacted
      insertActivity(api, { userId, campaignId: c.id, type: 'message', status: 'skipped', leadId: lead('d-d') })
      insertActivity(api, { userId, campaignId: c.id, type: 'message', status: 'failed', leadId: lead('d-d') })
      insertActivity(api, { userId, campaignId: c.id, type: 'condition', status: 'success', leadId: lead('d-d') })
      insertActivity(api, { userId, campaignId: c.id, type: 'accepted', status: 'success', leadId: lead('d-d') })
      insertActivity(api, { userId, campaignId: c.id, type: 'view_profile', status: 'skipped', leadId: lead('e-e') })
      // a deleted lead (lead_id set to NULL) still counts as a view, but not as a contacted lead
      insertActivity(api, { userId, campaignId: c.id, type: 'view_profile', status: 'success' })

      const res = await api.call('GET', `/api/campaigns/${c.id}`, { token })
      assert.deepEqual(res.body.stats, {
        totalLeads: 5,
        contacted: 3,
        invitesSent: 3,
        accepted: 2,
        messagesSent: 2,
        replied: 1,
        profileViews: 2,
        failed: 1,
      })
      const listed = (await api.call('GET', '/api/campaigns', { token })).body.find((x: any) => x.id === c.id)
      assert.deepEqual(listed.stats, res.body.stats)
    })
  })

  describe('update', () => {
    it('renames and updates settings', async () => {
      const c = (await create()).body
      const res = await api.call('PATCH', `/api/campaigns/${c.id}`, { token, body: { name: ' Renamed ', settings: { ...SETTINGS_NO_SKIP, dailyInvites: 5 } } })
      assert.equal(res.status, 200)
      assert.equal(res.body.name, 'Renamed')
      assert.equal(res.body.settings.dailyInvites, 5)
      assert.ok(res.body.updatedAt >= c.updatedAt)
      const bad = await api.call('PATCH', `/api/campaigns/${c.id}`, { token, body: { settings: { ...SETTINGS, dailyMessages: 301 } } })
      assert.equal(bad.status, 400)
      assert.ok(bad.body.details['settings.dailyMessages'])
    })

    it('applies status transitions', async () => {
      const c = (await create()).body
      const patch = (body: object) => api.call('PATCH', `/api/campaigns/${c.id}`, { token, body })
      assert.equal((await patch({ status: 'paused' })).status, 422, 'draft → paused')
      assert.equal((await patch({ status: 'completed' })).status, 422, 'draft → completed')
      assert.equal((await patch({ status: 'active' })).body.status, 'active')
      assert.equal((await patch({ status: 'active' })).status, 200, 'same status is a no-op')
      assert.equal((await patch({ status: 'paused' })).body.status, 'paused')
      const toDraft = await patch({ status: 'draft' })
      assert.equal(toDraft.status, 422)
      assert.match(toDraft.body.error, /draft/)
      assert.equal((await patch({ status: 'bogus' })).status, 400)
      assert.equal((await patch({ status: 'active' })).body.status, 'active', 'paused → active')

      run(api.db, `UPDATE campaigns SET status = 'completed' WHERE id = ?`, c.id)
      run(api.db, `UPDATE leads SET status = 'finished', next_action_at = NULL, current_step_id = NULL WHERE campaign_id = ?`, c.id)
      const again = await patch({ status: 'active' })
      assert.equal(again.status, 422, 'completed → active needs a runnable lead')
      assert.match(again.body.error, /No lead is waiting/)
      await api.call('POST', `/api/campaigns/${c.id}/leads`, { token, body: { leads: [{ profileUrl: profile('new-lead') }], searchImports: [] } })
      assert.equal((await patch({ status: 'active' })).body.status, 'active', 'completed → active with a new lead')
    })

    it('activating requires a non-empty sequence', async () => {
      const c = (await create({ sequence: emptySeq() })).body
      const res = await api.call('PATCH', `/api/campaigns/${c.id}`, { token, body: { status: 'active' } })
      assert.equal(res.status, 422)
      assert.match(res.body.error, /step/)
    })

    it('sequence edits: only while draft/paused (422 when active), then reconcile leads', async () => {
      const c = (await create({ status: 'active' })).body
      const patch = (body: object) => api.call('PATCH', `/api/campaigns/${c.id}`, { token, body })
      const leads = all<{ id: string; public_id: string }>(api.db, 'SELECT id, public_id FROM leads WHERE campaign_id = ?', c.id)
      const ada = leads.find((l) => l.public_id === 'ada-lovelace')!.id
      const alan = leads.find((l) => l.public_id === 'alan-turing')!.id
      // alan already got the invite and waits at the message step
      run(api.db, `UPDATE leads SET status = 'invited', current_step_id = 's2', last_action_at = ?, invited_at = ? WHERE id = ?`, Date.now(), Date.now(), alan)

      const newSeq = {
        rootId: 'v1',
        steps: {
          v1: { id: 'v1', kind: 'view_profile', delay: { min: 1, max: 5, unit: 'minutes' }, config: {}, next: 'v2' },
          v2: { id: 'v2', kind: 'invite', delay: { min: 1, max: 5, unit: 'minutes' }, config: { message: '' }, next: null },
        },
      }
      const blocked = await patch({ sequence: newSeq })
      assert.equal(blocked.status, 422)
      assert.equal(blocked.body.error, 'Pause the campaign before editing its sequence')

      // sending the unchanged sequence along with other fields is fine while active
      const same = await patch({ sequence: sampleSequence(), name: 'Still active' })
      assert.equal(same.status, 200)
      assert.equal(same.body.name, 'Still active')
      const reordered = sampleSequence() as any
      delete reordered.steps.s5.next // missing branch == null branch
      reordered.steps = Object.fromEntries(Object.entries(reordered.steps).reverse())
      assert.equal((await patch({ sequence: reordered })).status, 200)

      assert.equal((await patch({ status: 'paused' })).status, 200)
      const edited = await patch({ sequence: newSeq })
      assert.equal(edited.status, 200)
      assert.deepEqual(edited.body.sequence, newSeq)
      assert.equal(edited.body.stepCount, 2)

      const a = one<{ current_step_id: string; next_action_at: number; status: string }>(api.db, 'SELECT * FROM leads WHERE id = ?', ada)!
      assert.equal(a.current_step_id, 'v1', 'never-contacted lead restarts at the new root')
      assert.ok(a.next_action_at > Date.now())
      const t = one<{ current_step_id: string | null; next_action_at: number | null; status: string }>(api.db, 'SELECT * FROM leads WHERE id = ?', alan)!
      assert.equal(t.status, 'finished', 'in-progress lead whose step vanished is finished')
      assert.equal(t.next_action_at, null)

      const invalid = await patch({ sequence: { rootId: 'zz', steps: {} } })
      assert.equal(invalid.status, 400)
      assert.ok(invalid.body.details.sequence)

      // edit + start in one request
      const started = await patch({ sequence: sampleSequence(), status: 'active' })
      assert.equal(started.status, 200)
      assert.equal(started.body.status, 'active')
    })

    it('completed campaigns can change their sequence (no lead is running)', async () => {
      const c = (await create()).body
      run(api.db, `UPDATE campaigns SET status = 'completed' WHERE id = ?`, c.id)
      const res = await api.call('PATCH', `/api/campaigns/${c.id}`, { token, body: { sequence: emptySeq() } })
      assert.equal(res.status, 200)
      assert.equal(res.body.sequence.rootId, null)
      assert.equal(res.body.status, 'completed')
    })

    it('transition table', () => {
      assert.equal(transitionError('draft', 'active'), null)
      assert.equal(transitionError('paused', 'active'), null)
      assert.equal(transitionError('completed', 'active'), null)
      assert.equal(transitionError('active', 'paused'), null)
      assert.ok(transitionError('active', 'draft'))
      assert.ok(transitionError('paused', 'draft'))
      assert.ok(transitionError('draft', 'paused'))
      assert.ok(transitionError('completed', 'paused'))
      assert.ok(transitionError('active', 'completed'))
    })
  })

  describe('leads', () => {
    it('adds leads (deduped, invalid skipped) and imports', async () => {
      const c = (await create()).body
      const res = await api.call('POST', `/api/campaigns/${c.id}/leads`, {
        token,
        body: {
          leads: [{ profileUrl: profile('ada-lovelace') }, { profileUrl: 'garbage' }, { profileUrl: profile('grace-hopper'), listName: 'Navy' }],
          searchImports: [{ url: SEARCH, max: 25 }],
        },
      })
      assert.equal(res.status, 200)
      assert.deepEqual(res.body, { added: 1, skipped: 2, imports: 1 })
      const got = (await api.call('GET', `/api/campaigns/${c.id}`, { token })).body
      assert.equal(got.stats.totalLeads, 3)
      assert.equal(got.pendingImports, 1)

      const empty = await api.call('POST', `/api/campaigns/${c.id}/leads`, { token, body: { leads: [], searchImports: [] } })
      assert.equal(empty.status, 400)
      const badUrl = await api.call('POST', `/api/campaigns/${c.id}/leads`, { token, body: { leads: [], searchImports: [{ url: 'https://example.com', max: 5 }] } })
      assert.equal(badUrl.status, 400)
    })

    it('skips leads already in another active campaign when skipOtherCampaigns is on', async () => {
      await create({ status: 'active', leads: [{ profileUrl: profile('busy-person') }] })
      const c = (await create({ leads: [], settings: SETTINGS })).body
      const res = await api.call('POST', `/api/campaigns/${c.id}/leads`, { token, body: { leads: [{ profileUrl: profile('busy-person') }] } })
      assert.deepEqual(res.body, { added: 0, skipped: 1, imports: 0 })
      const lead = one<{ status: string }>(api.db, 'SELECT status FROM leads WHERE campaign_id = ?', c.id)!
      assert.equal(lead.status, 'skipped')
    })

    it('pages, filters and searches leads', async () => {
      const people = [
        { profileUrl: profile('p-1'), firstName: 'Linus', lastName: 'Torvalds', company: 'Linux Foundation' },
        { profileUrl: profile('p-2'), firstName: 'Margaret', lastName: 'Hamilton', headline: 'Apollo software lead' },
        { profileUrl: profile('p-3'), firstName: 'Ken', lastName: 'Thompson', company: 'Bell Labs' },
        { profileUrl: profile('p-4'), firstName: 'Dennis', lastName: 'Ritchie', company: 'Bell Labs' },
        { profileUrl: profile('p-5'), firstName: '100%', lastName: 'Literal' },
      ]
      const c = (await create({ leads: people })).body
      const url = (q: string) => `/api/campaigns/${c.id}/leads${q}`

      const all1 = await api.call('GET', url(''), { token })
      assert.equal(all1.status, 200)
      assert.equal(all1.body.total, 5)
      assert.deepEqual(
        all1.body.leads.map((l: any) => l.firstName),
        ['Linus', 'Margaret', 'Ken', 'Dennis', '100%'],
        'insertion order',
      )
      const lead = all1.body.leads[0]
      assert.deepEqual(Object.keys(lead).sort(), [
        'campaignId',
        'company',
        'createdAt',
        'currentStepId',
        'error',
        'firstName',
        'headline',
        'id',
        'lastAction',
        'lastActionAt',
        'lastName',
        'listName',
        'location',
        'nextActionAt',
        'profileUrl',
        'status',
      ])
      assert.equal(lead.profileUrl, profile('p-1'))
      assert.equal(lead.currentStepId, 's1')
      assert.match(lead.nextActionAt, /Z$/)

      const page = await api.call('GET', url('?offset=1&limit=2'), { token })
      assert.equal(page.body.total, 5)
      assert.deepEqual(
        page.body.leads.map((l: any) => l.firstName),
        ['Margaret', 'Ken'],
      )
      assert.equal((await api.call('GET', url('?q=bell'))).status, 401, 'token required')
      assert.equal((await api.call('GET', url('?q=bell%20labs'), { token })).body.total, 2)
      assert.equal((await api.call('GET', url('?q=apollo'), { token })).body.total, 1, 'headline')
      assert.equal((await api.call('GET', url('?q=margaret%20ham'), { token })).body.total, 1, 'full name')
      assert.equal((await api.call('GET', url('?q=100%25'), { token })).body.total, 1, '% is literal')
      assert.equal((await api.call('GET', url('?q=1_0'), { token })).body.total, 0, '_ is literal')

      const ids = all1.body.leads.map((l: any) => l.id)
      run(api.db, `UPDATE leads SET status = 'invited' WHERE id IN (?, ?)`, ids[0], ids[1])
      const invited = await api.call('GET', url('?status=invited'), { token })
      assert.equal(invited.body.total, 2)
      assert.equal((await api.call('GET', url('?status=nope'), { token })).status, 400)
      assert.equal((await api.call('GET', url('?limit=abc'), { token })).status, 400)
      assert.equal((await api.call('GET', url('?limit=1000'), { token })).body.leads.length, 5, 'limit is capped, not rejected')
    })

    it('deletes leads only within that campaign', async () => {
      const c1 = (await create()).body
      const c2 = (await create()).body
      const l1 = all<{ id: string }>(api.db, 'SELECT id FROM leads WHERE campaign_id = ?', c1.id).map((r) => r.id)
      const l2 = all<{ id: string }>(api.db, 'SELECT id FROM leads WHERE campaign_id = ?', c2.id).map((r) => r.id)
      const res = await api.call('DELETE', `/api/campaigns/${c1.id}/leads`, { token, body: { ids: [l1[0], l2[0]] } })
      assert.equal(res.status, 204)
      assert.equal(one<{ n: number }>(api.db, 'SELECT COUNT(*) AS n FROM leads WHERE campaign_id = ?', c1.id)!.n, 1)
      assert.equal(one<{ n: number }>(api.db, 'SELECT COUNT(*) AS n FROM leads WHERE campaign_id = ?', c2.id)!.n, 2)
      assert.equal((await api.call('DELETE', `/api/campaigns/${c1.id}/leads`, { token, body: { ids: [] } })).status, 400)
    })
  })

  describe('activity & delete', () => {
    it('lists campaign activity newest first with a capped limit', async () => {
      const c = (await create()).body
      const t = Date.now()
      insertActivity(api, { userId, campaignId: c.id, type: 'invite', status: 'success', at: t - 2000 })
      insertActivity(api, { userId, campaignId: c.id, type: 'message', status: 'success', at: t - 1000 })
      insertActivity(api, { userId, campaignId: null, type: 'session', status: 'failed', at: t })
      const res = await api.call('GET', `/api/campaigns/${c.id}/activity`, { token })
      assert.equal(res.status, 200)
      assert.deepEqual(
        res.body.map((a: any) => a.type),
        ['message', 'invite'],
      )
      assert.deepEqual(Object.keys(res.body[0]).sort(), ['campaignId', 'campaignName', 'createdAt', 'detail', 'id', 'leadId', 'leadName', 'status', 'stepId', 'type'])
      assert.equal((await api.call('GET', `/api/campaigns/${c.id}/activity?limit=1`, { token })).body.length, 1)
      assert.equal((await api.call('GET', `/api/campaigns/${c.id}/activity?limit=0`, { token })).status, 400)
    })

    it('deletes a campaign with its leads and imports; activities keep names', async () => {
      const c = (await create({ searchImports: [{ url: SEARCH, max: 5 }] })).body
      insertActivity(api, { userId, campaignId: c.id, type: 'invite', status: 'success' })
      const res = await api.call('DELETE', `/api/campaigns/${c.id}`, { token })
      assert.equal(res.status, 204)
      assert.equal((await api.call('GET', `/api/campaigns/${c.id}`, { token })).status, 404)
      assert.equal(one(api.db, 'SELECT 1 FROM leads WHERE campaign_id = ?', c.id), undefined)
      assert.equal(one(api.db, 'SELECT 1 FROM lead_imports WHERE campaign_id = ?', c.id), undefined)
      const act = one<{ campaign_id: string | null; campaign_name: string }>(api.db, `SELECT * FROM activities WHERE campaign_name = 'C' AND campaign_id IS NULL AND type = 'invite'`)
      assert.ok(act)
      assert.equal((await api.call('DELETE', `/api/campaigns/${c.id}`, { token })).status, 404)
    })
  })

  describe('isolation', () => {
    it("returns 404 for another user's campaign on every route", async () => {
      const c = (await create()).body
      const leadId = one<{ id: string }>(api.db, 'SELECT id FROM leads WHERE campaign_id = ?', c.id)!.id
      const other = await api.signup()
      const t = other.token
      const id = c.id
      for (const [method, path, body] of [
        ['GET', `/api/campaigns/${id}`],
        ['PATCH', `/api/campaigns/${id}`, { name: 'Hijacked' }],
        ['DELETE', `/api/campaigns/${id}`],
        ['GET', `/api/campaigns/${id}/leads`],
        ['POST', `/api/campaigns/${id}/leads`, { leads: [{ profileUrl: profile('x-y') }] }],
        ['DELETE', `/api/campaigns/${id}/leads`, { ids: [leadId] }],
        ['GET', `/api/campaigns/${id}/activity`],
      ] as [string, string, object?][]) {
        const res = await api.call(method, path, { token: t, body })
        assert.equal(res.status, 404, `${method} ${path}`)
      }
      assert.deepEqual((await api.call('GET', '/api/campaigns', { token: t })).body, [])
      const still = await api.call('GET', `/api/campaigns/${id}`, { token })
      assert.equal(still.body.name, c.name)
      assert.equal(still.body.stats.totalLeads, 2)
    })
  })
})
