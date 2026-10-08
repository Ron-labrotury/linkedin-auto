import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { one } from '../src/db/index.ts'
import { readAccount, updateAccount } from '../src/linkedin/accounts.ts'
import { hash32, sleep } from '../src/linkedin/common.ts'
import { createLinkedInService } from '../src/linkedin/index.ts'
import { createSimulatedService, nameFromEmail, SIM_CODE, simRepliedAfter } from '../src/linkedin/simulated.ts'
import { LinkedInError, type LinkedInDriver } from '../src/linkedin/types.ts'
import { addUser, simConfig, testDb } from './helpers/linkedin-db.ts'

function setup(sim = {}) {
  const db = testDb()
  const userId = addUser(db)
  const svc = createSimulatedService({ db, config: simConfig(sim) })
  return { db, userId, svc }
}

async function connected(sim = {}, email = 'sam.sender@example.com') {
  const s = setup(sim)
  const out = await s.svc.loginWithPassword(s.userId, email, 'secret')
  assert.equal(out.account.status, 'connected')
  return s
}

const url = (id: string) => `https://www.linkedin.com/in/${id}/`

/** An id (without magic words) whose hash puts it in a given bucket. */
function idWhere(pred: (h: number) => boolean, prefix = 'lead') {
  for (let i = 0; ; i++) if (pred(hash32(`${prefix}-${i}`))) return `${prefix}-${i}`
}

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof LinkedInError && e.code === code)
}

describe('simulated LinkedIn: connecting', () => {
  it('is selected by LINKEDIN_DRIVER=simulated', () => {
    const db = testDb()
    assert.equal(createLinkedInService({ db, config: simConfig() }).kind, 'simulated')
  })

  it('connects with a password and derives the profile from the email', async () => {
    const { db, userId, svc } = setup()
    const out = await svc.loginWithPassword(userId, ' jane.doe+work@example.com ', 'pw')
    assert.equal(out.account.status, 'connected')
    assert.equal(out.account.authMethod, 'password')
    assert.equal(out.account.email, 'jane.doe+work@example.com')
    assert.deepEqual(out.account.profile, {
      name: 'Jane Doe',
      headline: 'Simulated LinkedIn account',
      profileUrl: 'https://www.linkedin.com/in/simulated-user/',
      imageUrl: null,
    })
    assert.ok(out.message)
    const row = one<{ session_enc: string }>(db, 'SELECT session_enc FROM linkedin_accounts WHERE user_id = ?', userId)!
    assert.match(row.session_enc, /^v1\./, 'session stored encrypted')
    assert.equal(nameFromEmail('a_b-c@x.io'), 'A B C')
  })

  it('rejects the wrong password', async () => {
    const { userId, svc } = setup()
    const out = await svc.loginWithPassword(userId, 'sam@example.com', 'wrong-password')
    assert.equal(out.account.status, 'error')
    assert.equal(out.account.lastError, 'Wrong email or password')
    assert.equal(out.message, 'Wrong email or password')
  })

  it('asks for a verification code ("+code"), rejects a wrong one, accepts 123456', async () => {
    const { userId, svc } = setup()
    const first = await svc.loginWithPassword(userId, 'sam+code@example.com', 'pw')
    assert.equal(first.account.status, 'needs_verification')
    assert.equal(svc.getAccount(userId).status, 'needs_verification')
    const wrong = await svc.submitVerificationCode(userId, '000000')
    assert.equal(wrong.account.status, 'error')
    assert.equal(wrong.message, "That code didn't work")
    const ok = await svc.submitVerificationCode(userId, SIM_CODE)
    assert.equal(ok.account.status, 'connected')
    const again = await svc.submitVerificationCode(userId, SIM_CODE)
    assert.equal(again.account.status, 'connected', 'nothing pending any more')
  })

  it('waits for app approval ("+app") and connects on the second check', async () => {
    const { userId, svc } = setup()
    const first = await svc.loginWithPassword(userId, 'sam+app@example.com', 'pw')
    assert.equal(first.account.status, 'needs_app_approval')
    const waiting = await svc.checkPendingLogin(userId)
    assert.equal(waiting.account.status, 'needs_app_approval')
    const done = await svc.checkPendingLogin(userId)
    assert.equal(done.account.status, 'connected')
  })

  it('reports a sign-in interrupted by a restart', async () => {
    const { db, userId, svc } = setup()
    await svc.loginWithPassword(userId, 'sam+code@example.com', 'pw')
    const restarted = createSimulatedService({ db, config: simConfig() })
    assert.equal(restarted.getAccount(userId).status, 'error')
    const out = await restarted.submitVerificationCode(userId, SIM_CODE)
    assert.notEqual(out.account.status, 'connected')
  })

  it('connects with a cookie unless it is short or "expired"', async () => {
    const { userId, svc } = setup()
    assert.equal((await svc.connectWithCookie(userId, 'abc')).account.status, 'error')
    const expired = await svc.connectWithCookie(userId, 'expired')
    assert.equal(expired.account.status, 'error')
    assert.equal(expired.message, 'That cookie is invalid or expired')
    const ok = await svc.connectWithCookie(userId, 'AQEDARabcdefghijklmnop')
    assert.equal(ok.account.status, 'connected')
    assert.equal(ok.account.authMethod, 'cookie')
  })

  it('test() is ok only when connected; disconnect forgets everything', async () => {
    const { db, userId, svc } = await connected()
    const t = await svc.test(userId)
    assert.equal(t.ok, true)
    assert.ok(t.account.lastCheckedAt)
    await svc.disconnect(userId)
    const acc = readAccount(db, userId)
    assert.equal(acc.status, 'disconnected')
    assert.equal(acc.profile, null)
    assert.equal(one<{ session_enc: string | null }>(db, 'SELECT session_enc FROM linkedin_accounts WHERE user_id = ?', userId)!.session_enc, null)
    const t2 = await svc.test(userId)
    assert.equal(t2.ok, false)
    assert.equal(t2.message, 'Connect your LinkedIn account first.')
    await rejects(svc.withDriver(userId, async () => 1), 'session_expired')
  })

  it('awaits the configured action latency', async () => {
    const { userId, svc } = await connected({ actionLatencyMs: 60 })
    const t = Date.now()
    await svc.withDriver(userId, (d) => d.getConnectionStatus(url('someone')))
    assert.ok(Date.now() - t >= 55)
  })
})

describe('simulated LinkedIn: the driver world', () => {
  const run = <T>(svc: ReturnType<typeof setup>['svc'], userId: string, fn: (d: LinkedInDriver) => Promise<T>) => svc.withDriver(userId, fn)

  it('invite → pending → accepted after acceptAfterMs; then messages and replies', async () => {
    const { userId, svc } = await connected()
    const p = url('anna-accepter-replier')
    assert.equal(await run(svc, userId, (d) => d.getConnectionStatus(p)), 'not_connected')
    assert.equal(await run(svc, userId, (d) => d.sendMessage(p, 'hi', {})), 'not_connected')
    assert.equal(await run(svc, userId, (d) => d.sendInvite(p, 'Hi Anna')), 'sent')
    assert.equal(await run(svc, userId, (d) => d.getConnectionStatus(p)), 'pending')
    assert.equal(await run(svc, userId, (d) => d.sendInvite(p, null)), 'pending')
    await sleep(60)
    assert.equal(await run(svc, userId, (d) => d.getConnectionStatus(p)), 'connected')
    assert.equal(await run(svc, userId, (d) => d.sendInvite(p, null)), 'already_connected')

    assert.equal(await run(svc, userId, (d) => d.hasReplied(p, { after: null })), false)
    assert.equal(await run(svc, userId, (d) => d.sendMessage(p, 'Thanks!', {})), 'sent')
    assert.equal(await run(svc, userId, (d) => d.hasReplied(p, { after: 'Thanks!' })), false)
    // A retry of a message that already went out sends nothing.
    assert.equal(await run(svc, userId, (d) => d.sendMessage(p, ' Thanks! ', {})), 'already_sent')
    await sleep(80)
    assert.equal(await run(svc, userId, (d) => d.hasReplied(p, { after: 'Thanks!' })), true)
    assert.equal(await run(svc, userId, (d) => d.sendMessage(p, 'Follow-up', { stopIfRepliedAfter: { after: 'Thanks!' } })), 'replied')
    assert.equal(await run(svc, userId, (d) => d.sendMessage(p, 'Follow-up', {})), 'sent')
    // The reply came before the follow-up: nothing after our latest message.
    assert.equal(await run(svc, userId, (d) => d.hasReplied(p, { after: 'Follow-up' })), false)
    assert.equal(await run(svc, userId, (d) => d.hasReplied(p, { after: 'Thanks!' })), true)
  })

  it('reply checks follow the ReplyCheck rule', () => {
    const m = (from: 'me' | 'them', text: string, at: number) => ({ from, text, at })
    const thread = [m('them', 'old', 1), m('me', 'Hi', 2), m('them', 'Hey', 3), m('me', 'Manual', 4)]
    assert.equal(simRepliedAfter(thread, 'Hi'), true)
    assert.equal(simRepliedAfter(thread, null), false)
    assert.equal(simRepliedAfter(thread, 'not in the history'), false)
    assert.equal(simRepliedAfter([m('them', 'old', 1), m('me', 'Hi', 2)], null), false)
    assert.equal(simRepliedAfter([m('them', 'Thanks for connecting', 1)], null), true)
  })

  it('people whose hash says so never accept / never reply', async () => {
    const { userId, svc } = await connected()
    const stubborn = url(idWhere((h) => h % 10 >= 7))
    await run(svc, userId, (d) => d.sendInvite(stubborn, null))
    await sleep(60)
    assert.equal(await run(svc, userId, (d) => d.getConnectionStatus(stubborn)), 'pending')

    const silent = url(`${idWhere((h) => h % 10 >= 4, 'x-connected')}`)
    assert.equal(await run(svc, userId, (d) => d.getConnectionStatus(silent)), 'connected')
    assert.equal(await run(svc, userId, (d) => d.sendMessage(silent, 'hi', {})), 'sent')
    await sleep(80)
    assert.equal(await run(svc, userId, (d) => d.hasReplied(silent, { after: 'hi' })), false)
  })

  it('viewProfile returns a plausible, deterministic person', async () => {
    const { userId, svc } = await connected()
    const a = await run(svc, userId, (d) => d.viewProfile('https://linkedin.com/in/Mike-Johnson-1918?trk=x'))
    const b = await run(svc, userId, (d) => d.viewProfile(url('mike-johnson-1918')))
    assert.deepEqual(a, b)
    assert.equal(a.firstName, 'Mike')
    assert.equal(a.lastName, 'Johnson')
    assert.equal(a.profileUrl, url('mike-johnson-1918'))
    assert.equal(a.connection, 'not_connected')
    assert.ok(a.headline && a.company && a.location)
  })

  it('error rules: notfound, ratelimit, flaky, nonote', async () => {
    const { userId, svc } = await connected()
    await rejects(run(svc, userId, (d) => d.viewProfile(url('ghost-notfound'))), 'not_found')
    await rejects(run(svc, userId, (d) => d.follow(url('ghost-notfound'))), 'not_found')
    await rejects(run(svc, userId, (d) => d.sendInvite(url('busy-ratelimit'), null)), 'rate_limited')
    assert.equal(await run(svc, userId, (d) => d.viewProfile(url('busy-ratelimit'))).then((p) => p.connection), 'not_connected')

    const flaky = url('flaky-frank')
    await rejects(run(svc, userId, (d) => d.sendInvite(flaky, null)), 'unknown')
    await rejects(run(svc, userId, (d) => d.sendInvite(flaky, null)), 'unknown')
    assert.equal(await run(svc, userId, (d) => d.sendInvite(flaky, null)), 'sent')
    await rejects(run(svc, userId, (d) => d.follow(flaky)), 'unknown')

    assert.equal(await run(svc, userId, (d) => d.sendInvite(url('nina-nonote'), 'Hello!')), 'sent_without_note')
    assert.equal(await run(svc, userId, (d) => d.sendInvite(url('nora-nonote'), null)), 'sent')

    // "transient": the first call fails like a network outage, then it works.
    await rejects(run(svc, userId, (d) => d.sendInvite(url('tina-transient'), null)), 'transient')
    assert.equal(await run(svc, userId, (d) => d.sendInvite(url('tina-transient'), null)), 'sent')
  })

  it('"+lang" accounts: Test and every action report the interface language as an account problem', async () => {
    const { db, userId, svc } = await connected({}, 'sam+lang@example.com')
    await rejects(run(svc, userId, (d) => d.getConnectionStatus(url('a'))), 'account_problem')
    const account = readAccount(db, userId)
    assert.equal(account.status, 'error')
    assert.match(account.lastError ?? '', /English/)
    const t = await svc.test(userId)
    assert.equal(t.ok, false)
    assert.equal(t.account.status, 'error')
    assert.match(t.message, /Settings & Privacy → Account preferences → Language/)
    // A normal account in status "error" with a working session is repaired by Test.
    const other = await connected()
    updateAccount(other.db, other.userId, { status: 'error', lastError: 'x' })
    assert.equal((await other.svc.test(other.userId)).account.status, 'connected')
  })

  it('follow, like and withdraw behave sensibly', async () => {
    const { userId, svc } = await connected()
    const p = url('olga-accepter')
    assert.equal(await run(svc, userId, (d) => d.follow(p)), 'followed')
    assert.equal(await run(svc, userId, (d) => d.follow(p)), 'already_following')
    assert.equal(await run(svc, userId, (d) => d.follow(url('carl-connected'))), 'already_following')

    const poster = url(idWhere((h) => h % 5 !== 0))
    assert.equal(await run(svc, userId, (d) => d.likeLatestPost(poster)), 'liked')
    assert.equal(await run(svc, userId, (d) => d.likeLatestPost(poster)), 'already_liked')
    assert.equal(await run(svc, userId, (d) => d.likeLatestPost(url(idWhere((h) => h % 5 === 0)))), 'no_posts')

    const w = url(idWhere((h) => h % 10 >= 7, 'withdraw'))
    assert.equal(await run(svc, userId, (d) => d.withdrawInvite(w)), 'not_pending')
    await run(svc, userId, (d) => d.sendInvite(w, null))
    assert.equal(await run(svc, userId, (d) => d.withdrawInvite(w)), 'withdrawn')
    assert.equal(await run(svc, userId, (d) => d.getConnectionStatus(w)), 'not_connected')
  })

  it('search: 25 people over 3 pages, deterministic', async () => {
    const { userId, svc } = await connected()
    const search = 'https://www.linkedin.com/search/results/people/?keywords=growth'
    const p1 = await run(svc, userId, (d) => d.searchPeople(search, 1))
    const p2 = await run(svc, userId, (d) => d.searchPeople(search, 2))
    const p3 = await run(svc, userId, (d) => d.searchPeople(search, 3))
    const p4 = await run(svc, userId, (d) => d.searchPeople(search, 4))
    assert.deepEqual([p1.people.length, p2.people.length, p3.people.length, p4.people.length], [10, 10, 5, 0])
    assert.deepEqual([p1.hasMore, p2.hasMore, p3.hasMore, p4.hasMore], [true, true, false, false])
    assert.match(p1.people[0].profileUrl, /^https:\/\/www\.linkedin\.com\/in\/sim-[a-z0-9]+-1-1\/$/)
    const all = [...p1.people, ...p2.people, ...p3.people].map((p) => p.profileUrl)
    assert.equal(new Set(all).size, 25)
    assert.deepEqual(await run(svc, userId, (d) => d.searchPeople(search, 1)), p1)
    for (const person of p1.people) assert.ok(person.firstName && person.lastName && person.headline && person.location)
    // The profile of a search result is the same person.
    const view = await run(svc, userId, (d) => d.viewProfile(p1.people[0].profileUrl))
    assert.equal(`${view.firstName} ${view.lastName}`, `${p1.people[0].firstName} ${p1.people[0].lastName}`)
    await rejects(run(svc, userId, (d) => d.searchPeople('https://example.com/', 1)), 'action_unavailable')
  })

  it('"+expire" accounts are signed out on the 3rd driver action', async () => {
    const { db, userId, svc } = await connected({}, 'sam+expire@example.com')
    await run(svc, userId, (d) => d.getConnectionStatus(url('a')))
    await run(svc, userId, (d) => d.getConnectionStatus(url('b')))
    await rejects(run(svc, userId, (d) => d.getConnectionStatus(url('c'))), 'session_expired')
    assert.equal(readAccount(db, userId).status, 'expired')
    await rejects(run(svc, userId, (d) => d.getConnectionStatus(url('d'))), 'session_expired')
    assert.equal((await svc.test(userId)).ok, false)
    // Reconnecting works again.
    await svc.loginWithPassword(userId, 'sam+expire@example.com', 'pw')
    assert.equal(await run(svc, userId, (d) => d.getConnectionStatus(url('e'))), 'not_connected')
  })

  it('serializes withDriver calls per user', async () => {
    const { userId, svc } = await connected()
    const order: string[] = []
    await Promise.all([
      svc.withDriver(userId, async () => {
        order.push('a:start')
        await sleep(30)
        order.push('a:end')
      }),
      svc.withDriver(userId, async () => {
        order.push('b:start')
        order.push('b:end')
      }),
    ])
    assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end'])
  })
})
