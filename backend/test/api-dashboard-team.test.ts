import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { all, one, run } from '../src/db/index.ts'
import { startOfDayInZone } from '../../shared/time.ts'
import { type TestApi, SETTINGS, campaignInput, profile, startApi } from './helpers/api-server.ts'

function activity(api: TestApi, userId: string, type: string, status: string, at: number, campaignId: string | null = null) {
  run(
    api.db,
    `INSERT INTO activities (id, user_id, campaign_id, campaign_name, type, status, detail, created_at) VALUES (?, ?, ?, 'C', ?, ?, '', ?)`,
    `act_${Math.random().toString(36).slice(2)}`,
    userId,
    campaignId,
    type,
    status,
    at,
  )
}

describe('dashboard API', () => {
  let api: TestApi
  before(async () => {
    api = await startApi()
  })
  after(() => api.close())

  it('returns an empty dashboard for a new user', async () => {
    const { token } = await api.signup()
    const res = await api.call('GET', '/api/dashboard', { token })
    assert.equal(res.status, 200)
    const d = res.body
    assert.equal(d.linkedin.status, 'disconnected')
    assert.deepEqual(d.today, { invites: { done: 0, limit: 0 }, messages: { done: 0, limit: 0 }, profileViews: { done: 0, limit: 0 } })
    assert.equal(d.pendingInvites, 0)
    assert.equal(d.accepted, 0)
    assert.equal(d.replies, 0)
    assert.equal(typeof d.withinActiveHours, 'boolean')
    assert.equal(d.nextActionAt, null)
    assert.deepEqual(d.activity, [])
    assert.deepEqual(d.campaigns, [])
  })

  it('counts today in the user time zone, sums active-campaign limits, and reports engine timing', async () => {
    const { token, user } = await api.signup()
    // every day, all day → always within active hours
    await api.call('PUT', '/api/settings', {
      token,
      body: { timezone: 'UTC', activeDays: [0, 1, 2, 3, 4, 5, 6], activeStart: '00:00', activeEnd: '23:59', gapMinMinutes: 1, gapMaxMinutes: 5 },
    })
    const s = { ...SETTINGS, skipOtherCampaigns: false }
    const a = (await api.call('POST', '/api/campaigns', { token, body: campaignInput({ status: 'active', settings: { ...s, dailyInvites: 10, dailyMessages: 20, dailyProfileViews: 30 } }) })).body
    await api.call('POST', '/api/campaigns', { token, body: campaignInput({ status: 'active', settings: { ...s, dailyInvites: 5, dailyMessages: 6, dailyProfileViews: 7 } }) })
    await api.call('POST', '/api/campaigns', { token, body: campaignInput({ status: 'draft', settings: { ...s, dailyInvites: 100 } }) })

    const now = Date.now()
    const midnight = startOfDayInZone(new Date(now), 'UTC').getTime()
    activity(api, user.id, 'invite', 'success', now, a.id)
    activity(api, user.id, 'invite', 'success', midnight, a.id)
    activity(api, user.id, 'invite', 'success', midnight - 1, a.id) // yesterday
    activity(api, user.id, 'invite', 'failed', now, a.id)
    activity(api, user.id, 'message', 'success', now, a.id)
    activity(api, user.id, 'view_profile', 'success', now, a.id)
    activity(api, user.id, 'view_profile', 'skipped', now, a.id)

    const leads = all<{ id: string }>(api.db, 'SELECT id FROM leads WHERE campaign_id = ? ORDER BY rowid', a.id)
    run(api.db, `UPDATE leads SET status = 'invited', invited_at = ? WHERE id = ?`, now, leads[0].id)
    run(api.db, `UPDATE leads SET status = 'replied', invited_at = ?, connected_at = ?, replied_at = ? WHERE id = ?`, now, now, now, leads[1].id)

    const next = now + 3 * 60_000
    api.engine.next.set(user.id, next)

    const d = (await api.call('GET', '/api/dashboard', { token })).body
    assert.deepEqual(d.today, { invites: { done: 2, limit: 15 }, messages: { done: 1, limit: 26 }, profileViews: { done: 1, limit: 37 } })
    assert.equal(d.pendingInvites, 1)
    assert.equal(d.accepted, 1)
    assert.equal(d.replies, 1)
    assert.equal(d.nextActionAt, new Date(next).toISOString())
    assert.equal(d.activity.length, 7)
    assert.equal(d.campaigns.length, 3)
    assert.equal(d.withinActiveHours, new Date(now).getUTCHours() * 60 + new Date(now).getUTCMinutes() < 23 * 60 + 59)
  })

  it('limits activity to 20 and campaigns to the 5 most recently updated', async () => {
    const { token, user } = await api.signup()
    const ids: string[] = []
    for (let i = 0; i < 7; i++) ids.push((await api.call('POST', '/api/campaigns', { token, body: campaignInput({ name: `C${i}` }) })).body.id)
    for (const [i, id] of ids.entries()) run(api.db, 'UPDATE campaigns SET updated_at = ? WHERE id = ?', 1_000_000 + i, id)
    run(api.db, 'UPDATE campaigns SET updated_at = ? WHERE id = ?', 9_000_000, ids[0])
    for (let i = 0; i < 25; i++) activity(api, user.id, 'invite', 'success', Date.now() - i * 1000)
    const d = (await api.call('GET', '/api/dashboard', { token })).body
    assert.equal(d.activity.length, 20)
    assert.deepEqual(
      d.campaigns.map((c: any) => c.name),
      ['C0', 'C6', 'C5', 'C4', 'C3'],
    )
  })
})

describe('team API', () => {
  let api: TestApi
  before(async () => {
    api = await startApi({ publicAppUrl: 'https://app.example.com' })
  })
  after(() => api.close())

  it('invite flow: create → lookup → signup joins the workspace → single use', async () => {
    const owner = await api.signup({ name: 'Olivia Owner', email: 'owner1@example.com' })
    const inv = await api.call('POST', '/api/team/invites', { token: owner.token, body: { email: ' New.Admin@Example.com ', role: 'admin' } })
    assert.equal(inv.status, 201)
    assert.equal(inv.body.email, 'new.admin@example.com')
    assert.equal(inv.body.role, 'admin')
    assert.equal(inv.body.url, `https://app.example.com/signup?invite=${inv.body.token}`)

    const look = await api.call('GET', `/api/auth/invite/${inv.body.token}`)
    assert.equal(look.status, 200)
    assert.deepEqual(look.body, { email: 'new.admin@example.com', workspaceName: "Olivia Owner's workspace", role: 'admin' })
    assert.equal((await api.call('GET', '/api/auth/invite/nope')).status, 404)

    const mismatch = await api.call('POST', '/api/auth/signup', {
      body: { name: 'Mallory', email: 'mallory@example.com', password: 'password123', inviteToken: inv.body.token },
    })
    assert.equal(mismatch.status, 400)
    assert.ok(mismatch.body.details.email)

    const joined = await api.signup({ name: 'Ann Admin', email: 'NEW.ADMIN@example.com', inviteToken: inv.body.token })
    assert.equal(joined.user.role, 'admin')
    assert.equal(joined.user.workspaceId, owner.user.workspaceId)
    assert.equal(one(api.db, 'SELECT 1 FROM workspaces WHERE name = ?', "Ann Admin's workspace"), undefined)
    assert.ok(one<{ accepted_at: number }>(api.db, 'SELECT accepted_at FROM invites WHERE token = ?', inv.body.token)!.accepted_at)

    assert.equal((await api.call('GET', `/api/auth/invite/${inv.body.token}`)).status, 404)
    const reuse = await api.call('POST', '/api/auth/signup', {
      body: { name: 'Again', email: 'again@example.com', password: 'password123', inviteToken: inv.body.token },
    })
    assert.equal(reuse.status, 400)
    assert.ok(reuse.body.details.inviteToken)

    const team = (await api.call('GET', '/api/team', { token: joined.token })).body
    assert.equal(team.workspaceName, "Olivia Owner's workspace")
    assert.deepEqual(
      team.members.map((m: any) => [m.email, m.role, m.linkedinStatus, m.activeCampaigns]),
      [
        ['owner1@example.com', 'owner', 'disconnected', 0],
        ['new.admin@example.com', 'admin', 'disconnected', 0],
      ],
    )
    assert.deepEqual(team.invites, [])
  })

  it('invites: 409 for registered emails, re-invite replaces, revoke, relative URLs', async () => {
    const owner = await api.signup()
    const taken = await api.call('POST', '/api/team/invites', { token: owner.token, body: { email: owner.user.email, role: 'member' } })
    assert.equal(taken.status, 409)
    const bad = await api.call('POST', '/api/team/invites', { token: owner.token, body: { email: 'x@example.com', role: 'owner' } })
    assert.equal(bad.status, 400)

    const first = (await api.call('POST', '/api/team/invites', { token: owner.token, body: { email: 'twice@example.com', role: 'member' } })).body
    const second = (await api.call('POST', '/api/team/invites', { token: owner.token, body: { email: 'twice@example.com', role: 'admin' } })).body
    const team = (await api.call('GET', '/api/team', { token: owner.token })).body
    assert.deepEqual(
      team.invites.map((i: any) => [i.token, i.role]),
      [[second.token, 'admin']],
    )
    assert.notEqual(first.token, second.token)

    assert.equal((await api.call('DELETE', `/api/team/invites/${second.token}`, { token: owner.token })).status, 204)
    assert.equal((await api.call('DELETE', `/api/team/invites/${second.token}`, { token: owner.token })).status, 404)
    assert.deepEqual((await api.call('GET', '/api/team', { token: owner.token })).body.invites, [])

    const rel = await startApi()
    try {
      const o = await rel.signup()
      const r = await rel.call('POST', '/api/team/invites', { token: o.token, body: { email: 'rel@example.com', role: 'member' } })
      assert.equal(r.body.url, `/signup?invite=${r.body.token}`)
    } finally {
      await rel.close()
    }
  })

  it('enforces roles: members cannot manage, only the owner changes roles, owner/self cannot be removed', async () => {
    const owner = await api.signup()
    const invite = async (email: string, role: string) =>
      (await api.call('POST', '/api/team/invites', { token: owner.token, body: { email, role } })).body.token as string
    const admin = await api.signup({ email: 'adm@example.com', inviteToken: await invite('adm@example.com', 'admin') })
    const member = await api.signup({ email: 'mem@example.com', inviteToken: await invite('mem@example.com', 'member') })
    const member2 = await api.signup({ email: 'mem2@example.com', inviteToken: await invite('mem2@example.com', 'member') })

    // members
    assert.equal((await api.call('POST', '/api/team/invites', { token: member.token, body: { email: 'z@example.com', role: 'member' } })).status, 403)
    assert.equal((await api.call('DELETE', `/api/team/members/${member2.user.id}`, { token: member.token })).status, 403)
    assert.equal((await api.call('PATCH', `/api/team/members/${member2.user.id}`, { token: member.token, body: { role: 'admin' } })).status, 403)
    const pending = await invite('pending@example.com', 'member')
    assert.equal((await api.call('DELETE', `/api/team/invites/${pending}`, { token: member.token })).status, 403)
    assert.deepEqual((await api.call('GET', '/api/team', { token: member.token })).body.invites, [], 'members do not see invite links')
    assert.equal((await api.call('GET', '/api/team', { token: admin.token })).body.invites.length, 1)

    // admins can invite but not change roles
    assert.equal((await api.call('POST', '/api/team/invites', { token: admin.token, body: { email: 'by-admin@example.com', role: 'member' } })).status, 201)
    assert.equal((await api.call('PATCH', `/api/team/members/${member.user.id}`, { token: admin.token, body: { role: 'admin' } })).status, 403)

    // owner changes roles
    const promoted = await api.call('PATCH', `/api/team/members/${member.user.id}`, { token: owner.token, body: { role: 'admin' } })
    assert.equal(promoted.status, 200)
    assert.equal(promoted.body.role, 'admin')
    assert.deepEqual(Object.keys(promoted.body).sort(), ['activeCampaigns', 'createdAt', 'email', 'id', 'linkedinStatus', 'name', 'role'])
    assert.equal((await api.call('GET', '/api/auth/me', { token: member.token })).body.role, 'admin', 'role applies immediately')
    assert.equal((await api.call('PATCH', `/api/team/members/${owner.user.id}`, { token: owner.token, body: { role: 'member' } })).status, 422)
    assert.equal((await api.call('PATCH', `/api/team/members/${member.user.id}`, { token: owner.token, body: { role: 'owner' } })).status, 400)

    // removal rules
    assert.equal((await api.call('DELETE', `/api/team/members/${owner.user.id}`, { token: admin.token })).status, 422)
    assert.equal((await api.call('DELETE', `/api/team/members/${admin.user.id}`, { token: admin.token })).status, 422)
    assert.equal((await api.call('DELETE', `/api/team/members/usr_missing`, { token: owner.token })).status, 404)

    // other workspaces are invisible
    const outsider = await api.signup()
    assert.equal((await api.call('DELETE', `/api/team/members/${member2.user.id}`, { token: outsider.token })).status, 404)
    assert.equal((await api.call('PATCH', `/api/team/members/${member2.user.id}`, { token: outsider.token, body: { role: 'admin' } })).status, 404)
    assert.equal((await api.call('DELETE', `/api/team/invites/${pending}`, { token: outsider.token })).status, 404)
    assert.equal((await api.call('GET', '/api/team', { token: outsider.token })).body.members.length, 1)
  })

  it('invite links expire after 7 days: lookup 404, signup 400, hidden from the team page', async () => {
    const owner = await api.signup()
    const create = async (email: string) =>
      (await api.call('POST', '/api/team/invites', { token: owner.token, body: { email, role: 'member' } })).body.token as string
    const fresh = await create('fresh@example.com')
    const stale = await create('stale@example.com')
    const legacyOld = await create('legacy-old@example.com')
    const legacyNew = await create('legacy-new@example.com')

    const row = one<{ created_at: number; expires_at: number }>(api.db, 'SELECT created_at, expires_at FROM invites WHERE token = ?', fresh)!
    assert.equal(row.expires_at - row.created_at, 7 * 86_400_000)

    const now = Date.now()
    run(api.db, 'UPDATE invites SET expires_at = ? WHERE token = ?', now - 1, stale)
    // invites created before expiry existed have no expires_at: they expire 7 days after creation
    run(api.db, 'UPDATE invites SET expires_at = NULL, created_at = ? WHERE token = ?', now - 8 * 86_400_000, legacyOld)
    run(api.db, 'UPDATE invites SET expires_at = NULL, created_at = ? WHERE token = ?', now - 86_400_000, legacyNew)

    for (const [token, ok] of [
      [fresh, true],
      [stale, false],
      [legacyOld, false],
      [legacyNew, true],
    ] as const)
      assert.equal((await api.call('GET', `/api/auth/invite/${token}`)).status, ok ? 200 : 404, token)
    const team = (await api.call('GET', '/api/team', { token: owner.token })).body
    assert.deepEqual(team.invites.map((i: any) => i.email).sort(), ['fresh@example.com', 'legacy-new@example.com'])

    const expired = await api.call('POST', '/api/auth/signup', {
      body: { name: 'Late', email: 'stale@example.com', password: 'password123', inviteToken: stale },
    })
    assert.equal(expired.status, 400)
    assert.match(expired.body.error, /expired/)
    assert.ok(expired.body.details.inviteToken)
    assert.equal(one(api.db, 'SELECT 1 FROM users WHERE email = ?', 'stale@example.com'), undefined)
    assert.equal(one<{ accepted_at: number | null }>(api.db, 'SELECT accepted_at FROM invites WHERE token = ?', stale)!.accepted_at, null)

    const joined = await api.signup({ email: 'legacy-new@example.com', inviteToken: legacyNew })
    assert.equal(joined.user.workspaceId, owner.user.workspaceId)
  })

  it('removing or demoting an admin revokes the pending invites they created', async () => {
    const owner = await api.signup()
    const invite = async (by: string, email: string, role: string) => {
      const res = await api.call('POST', '/api/team/invites', { token: by, body: { email, role } })
      assert.equal(res.status, 201)
      return res.body.token as string
    }
    const alice = await api.signup({ email: 'alice@example.com', inviteToken: await invite(owner.token, 'alice@example.com', 'admin') })
    const bob = await api.signup({ email: 'bob@example.com', inviteToken: await invite(owner.token, 'bob@example.com', 'admin') })
    const byOwner = await invite(owner.token, 'by-owner@example.com', 'member')
    const backdoor = await invite(alice.token, 'alice.backup@evil.test', 'admin')
    const byBob = await invite(bob.token, 'by-bob@example.com', 'admin')
    const byBobAccepted = await invite(bob.token, 'carol@example.com', 'member')
    await api.signup({ email: 'carol@example.com', inviteToken: byBobAccepted })

    // removal: Alice's planted admin invite stops working
    assert.equal((await api.call('DELETE', `/api/team/members/${alice.user.id}`, { token: owner.token })).status, 204)
    assert.equal((await api.call('GET', `/api/auth/invite/${backdoor}`)).status, 404)
    const rejoin = await api.call('POST', '/api/auth/signup', {
      body: { name: 'Alice', email: 'alice.backup@evil.test', password: 'password123', inviteToken: backdoor },
    })
    assert.equal(rejoin.status, 400)
    assert.equal(one(api.db, 'SELECT 1 FROM users WHERE email = ?', 'alice.backup@evil.test'), undefined)

    // promoting keeps invites; demoting Bob to member revokes his pending ones (accepted ones stay)
    assert.equal((await api.call('PATCH', `/api/team/members/${bob.user.id}`, { token: owner.token, body: { role: 'admin' } })).status, 200)
    assert.equal((await api.call('GET', `/api/auth/invite/${byBob}`)).status, 200)
    assert.equal((await api.call('PATCH', `/api/team/members/${bob.user.id}`, { token: owner.token, body: { role: 'member' } })).status, 200)
    assert.equal((await api.call('GET', `/api/auth/invite/${byBob}`)).status, 404)
    assert.ok(one(api.db, 'SELECT 1 FROM invites WHERE token = ?', byBobAccepted), 'accepted invite rows are kept')

    // invites by others are untouched
    assert.equal((await api.call('GET', `/api/auth/invite/${byOwner}`)).status, 200)
    const team = (await api.call('GET', '/api/team', { token: owner.token })).body
    assert.deepEqual(
      team.invites.map((i: any) => i.email),
      ['by-owner@example.com'],
    )
  })

  it('removing a member deletes the user, their campaigns, leads, sessions and LinkedIn session', async () => {
    const owner = await api.signup()
    const token = (await api.call('POST', '/api/team/invites', { token: owner.token, body: { email: 'leaver@example.com', role: 'member' } })).body.token
    const leaver = await api.signup({ email: 'leaver@example.com', inviteToken: token })
    const c = (
      await api.call('POST', '/api/campaigns', {
        token: leaver.token,
        body: campaignInput({ status: 'active', settings: { ...SETTINGS, skipOtherCampaigns: false }, leads: [{ profileUrl: profile('someone-x') }] }),
      })
    ).body
    assert.equal((await api.call('GET', '/api/team', { token: owner.token })).body.members.find((m: any) => m.id === leaver.user.id).activeCampaigns, 1)

    const res = await api.call('DELETE', `/api/team/members/${leaver.user.id}`, { token: owner.token })
    assert.equal(res.status, 204)
    assert.ok(api.linkedin.calls.some((x) => x.method === 'disconnect' && x.userId === leaver.user.id))
    assert.equal(one(api.db, 'SELECT 1 FROM users WHERE id = ?', leaver.user.id), undefined)
    assert.equal(one(api.db, 'SELECT 1 FROM campaigns WHERE id = ?', c.id), undefined)
    assert.equal(one(api.db, 'SELECT 1 FROM leads WHERE campaign_id = ?', c.id), undefined)
    assert.equal(one(api.db, 'SELECT 1 FROM linkedin_accounts WHERE user_id = ?', leaver.user.id), undefined)
    assert.equal((await api.call('GET', '/api/auth/me', { token: leaver.token })).status, 401)
    assert.equal((await api.call('GET', '/api/team', { token: owner.token })).body.members.length, 1)
  })
})
