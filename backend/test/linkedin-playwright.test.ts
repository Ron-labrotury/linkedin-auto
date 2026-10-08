/**
 * The Playwright LinkedIn service end-to-end (sign-in flows, cookie, test, sessions) against a
 * fake linkedin.com served through request routing.
 */
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { config } from '../src/config.ts'
import { one } from '../src/db/index.ts'
import { decrypt } from '../src/crypto.ts'
import { loadSession, readAccount } from '../src/linkedin/accounts.ts'
import { sleep } from '../src/linkedin/common.ts'
import { createLinkedInService } from '../src/linkedin/index.ts'
import { createPlaywrightService, maxContextsFromEnv, type PlaywrightService, type PlaywrightServiceOptions } from '../src/linkedin/playwright/service.ts'
import { LinkedInError, type LinkedInService } from '../src/linkedin/types.ts'
import { FAST, routeLinkedIn } from './helpers/linkedin-browser.ts'
import { addUser, testDb } from './helpers/linkedin-db.ts'
import { fakeSite, PIN } from './helpers/linkedin-fake-site.ts'

const site = fakeSite()
const db = testDb()
const services: LinkedInService[] = []

function service(opts: Partial<PlaywrightServiceOptions> = {}): PlaywrightService {
  const svc = createPlaywrightService({
    db,
    config: { ...config, headless: true, linkedinDriver: 'playwright' },
    pacing: FAST,
    loginTimeoutMs: 8_000,
    checkWaitMs: 1_500,
    setupContext: (ctx) => routeLinkedIn(ctx, site.handler),
    ...opts,
  })
  services.push(svc)
  return svc
}
const svc = service()

after(async () => {
  for (const s of services) await s.shutdown()
})

const person = (id: string, cfg = {}) => {
  site.profiles.set(id, cfg)
  return `https://www.linkedin.com/in/${id}/`
}
const sessionCookie = (userId: string) =>
  loadSession<{ cookies: { name: string; value: string }[] }>(db, userId)?.cookies.find((c) => c.name === 'li_at')?.value
const rejectsWith = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof LinkedInError && e.code === code)

describe('Playwright LinkedIn service: sign-in', () => {
  it('is the default driver', () => {
    const s = createLinkedInService({ db, config: { ...config, linkedinDriver: 'playwright' } })
    assert.equal(s.kind, 'playwright')
    services.push(s)
  })

  it('signs in with email + password, reads the profile and stores the session encrypted', async () => {
    const userId = addUser(db, { timezone: 'Asia/Kolkata' })
    const out = await svc.loginWithPassword(userId, ' sam@example.com ', 'correct horse battery')
    assert.equal(out.account.status, 'connected', out.message)
    assert.equal(out.account.authMethod, 'password')
    assert.equal(out.account.email, 'sam@example.com')
    assert.deepEqual(out.account.profile && { ...out.account.profile, imageUrl: !!out.account.profile.imageUrl }, {
      name: 'Sam Sender',
      headline: 'Founder at Outbound Co',
      profileUrl: 'https://www.linkedin.com/in/sam-sender/',
      imageUrl: true,
    })
    assert.match(out.message, /Sam Sender/)
    assert.ok(site.logins.includes('sam@example.com'))
    const cookie = sessionCookie(userId)
    assert.ok(cookie && site.sessions.has(cookie), 'the logged-in cookie is stored')
    const raw = one<{ session_enc: string }>(db, 'SELECT session_enc FROM linkedin_accounts WHERE user_id = ?', userId)!.session_enc
    assert.ok(!raw.includes(cookie!), 'encrypted at rest')
    assert.ok(!decrypt(raw)!.includes('correct horse battery'), 'the password is never stored')

    // The engine can use the session right away.
    const profile = await svc.withDriver(userId, (d) => d.viewProfile(person('lead-one')))
    assert.equal(profile.firstName, 'Jane')
    assert.equal(profile.connection, 'not_connected')
  })

  it('reports a wrong password', async () => {
    const userId = addUser(db)
    const out = await svc.loginWithPassword(userId, 'sam@example.com', 'wrong')
    assert.equal(out.account.status, 'error')
    assert.equal(out.message, 'Wrong email or password')
    assert.equal(out.account.lastError, 'Wrong email or password')
  })

  it('suggests the cookie method on a captcha', async () => {
    const userId = addUser(db)
    const out = await svc.loginWithPassword(userId, 'captcha@example.com', 'pw')
    assert.equal(out.account.status, 'error')
    assert.match(out.message, /security check.*li_at cookie/i)
  })

  it('verification code: keeps the page alive, retries a wrong code, connects with the right one', async () => {
    const userId = addUser(db)
    const first = await svc.loginWithPassword(userId, 'pin@example.com', 'pw')
    assert.equal(first.account.status, 'needs_verification', first.message)
    assert.match(first.message, /s\*\*\*@example\.com/)
    assert.equal(svc.getAccount(userId).status, 'needs_verification')

    const bad = await svc.submitVerificationCode(userId, '000000')
    assert.equal(bad.account.status, 'needs_verification')
    assert.match(bad.message, /didn't work/)

    const ok = await svc.submitVerificationCode(userId, PIN)
    assert.equal(ok.account.status, 'connected', ok.message)
    assert.equal(ok.account.profile?.name, 'Sam Sender')

    const again = await svc.submitVerificationCode(userId, PIN)
    assert.equal(again.account.status, 'connected')
    assert.match(again.message, /already connected/)
  })

  it('app approval: waits, then connects once approved', async () => {
    const userId = addUser(db)
    site.appApproved = false
    const first = await svc.loginWithPassword(userId, 'app@example.com', 'pw')
    assert.equal(first.account.status, 'needs_app_approval', first.message)
    const waiting = await svc.checkPendingLogin(userId)
    assert.equal(waiting.account.status, 'needs_app_approval')
    assert.match(waiting.message, /waiting/i)
    site.appApproved = true
    const done = await svc.checkPendingLogin(userId)
    site.appApproved = false
    assert.equal(done.account.status, 'connected', done.message)
  })

  it('skips post-login interstitials', async () => {
    const userId = addUser(db)
    const out = await svc.loginWithPassword(userId, 'phone@example.com', 'pw')
    assert.equal(out.account.status, 'connected', out.message)
  })

  it('times out a pending verification', async () => {
    const quick = service({ pendingTtlMs: 300 })
    const userId = addUser(db)
    assert.equal((await quick.loginWithPassword(userId, 'pin@example.com', 'pw')).account.status, 'needs_verification')
    await sleep(700)
    const account = readAccount(db, userId)
    assert.equal(account.status, 'error')
    assert.match(account.lastError ?? '', /timed out/i)
    assert.notEqual((await quick.submitVerificationCode(userId, PIN)).account.status, 'connected')
  })

  it('a restarted server reports an interrupted sign-in', async () => {
    const userId = addUser(db)
    await svc.loginWithPassword(userId, 'pin@example.com', 'pw')
    const restarted = service()
    assert.equal(restarted.getAccount(userId).status, 'error')
    await svc.disconnect(userId)
  })
})

describe('Playwright LinkedIn service: cookie, test, sessions', () => {
  it('connects with a valid li_at cookie and rejects an invalid one', async () => {
    const userId = addUser(db)
    const bad = await svc.connectWithCookie(userId, 'AQEDAR-not-a-real-session')
    assert.equal(bad.account.status, 'error')
    assert.equal(bad.message, 'That cookie is invalid or expired')
    const short = await svc.connectWithCookie(userId, 'abc')
    assert.equal(short.account.status, 'error')

    const ok = await svc.connectWithCookie(userId, `li_at=${site.newSession()};`)
    assert.equal(ok.account.status, 'connected', ok.message)
    assert.equal(ok.account.authMethod, 'cookie')
    assert.equal(ok.account.email, null)
    assert.equal(ok.account.profile?.name, 'Sam Sender')
  })

  it('test(): ok while the session works, expired once LinkedIn signs it out', async () => {
    const userId = addUser(db)
    const none = await svc.test(userId)
    assert.equal(none.ok, false)
    assert.equal(none.message, 'Connect your LinkedIn account first.')

    const cookie = site.newSession()
    await svc.connectWithCookie(userId, cookie)
    const ok = await svc.test(userId)
    assert.equal(ok.ok, true, ok.message)
    assert.ok(ok.account.lastCheckedAt)
    assert.equal(ok.account.status, 'connected')

    site.sessions.delete(cookie)
    const gone = await svc.test(userId)
    assert.equal(gone.ok, false)
    assert.equal(gone.account.status, 'expired')
    assert.equal(gone.account.profile?.name, 'Sam Sender', 'the profile is kept')
  })

  it('withDriver: marks the account expired when LinkedIn redirects to sign-in', async () => {
    const userId = addUser(db)
    const cookie = site.newSession()
    await svc.connectWithCookie(userId, cookie)
    assert.equal(await svc.withDriver(userId, (d) => d.getConnectionStatus(person('lead-two', { state: 'connected' }))), 'connected')
    site.sessions.delete(cookie)
    await rejectsWith(
      svc.withDriver(userId, (d) => d.viewProfile(person('lead-three'))),
      'session_expired',
    )
    assert.equal(readAccount(db, userId).status, 'expired')
    await rejectsWith(svc.withDriver(userId, async () => 1), 'session_expired')
  })

  it('withDriver: serialized per user, and the context is rebuilt from the stored session', async () => {
    const userId = addUser(db)
    await svc.connectWithCookie(userId, site.newSession())
    const order: string[] = []
    await Promise.all([
      svc.withDriver(userId, async () => {
        order.push('a')
        await sleep(50)
        order.push('a')
      }),
      svc.withDriver(userId, async () => {
        order.push('b')
      }),
    ])
    assert.deepEqual(order, ['a', 'a', 'b'])
    // A fresh service (e.g. after a restart) uses the encrypted storage state.
    const other = service()
    assert.equal(await other.withDriver(userId, (d) => d.getConnectionStatus(person('lead-four', { state: 'pending' }))), 'pending')
  })

  it('disconnect forgets the session', async () => {
    const userId = addUser(db)
    await svc.connectWithCookie(userId, site.newSession())
    await svc.disconnect(userId)
    const account = readAccount(db, userId)
    assert.equal(account.status, 'disconnected')
    assert.equal(account.profile, null)
    assert.equal(loadSession(db, userId), null)
    await rejectsWith(svc.withDriver(userId, async () => 1), 'session_expired')
  })
})

describe('Playwright LinkedIn service: account problems', () => {
  it('a non-English LinkedIn interface: connect and Test report it, actions fail with account_problem', async () => {
    const userId = addUser(db)
    site.uiLang = 'de'
    try {
      const out = await svc.connectWithCookie(userId, site.newSession())
      assert.equal(out.account.status, 'error')
      assert.match(out.message, /English.*Settings & Privacy → Account preferences → Language/)
      assert.equal(out.account.lastError, out.message)
      assert.ok(sessionCookie(userId), 'the session is kept, so Test can finish the connection later')
      const t = await svc.test(userId)
      assert.equal(t.ok, false)
      assert.equal(t.account.status, 'error')
      assert.match(t.message, /English/)
    } finally {
      site.uiLang = 'en'
    }
    const ok = await svc.test(userId)
    assert.equal(ok.ok, true, ok.message)
    assert.equal(ok.account.status, 'connected')

    // Switched back to another language later: the next action stops the account.
    await rejectsWith(svc.withDriver(userId, (d) => d.viewProfile(person('lead-lang', { lang: 'es' }))), 'account_problem')
    const account = readAccount(db, userId)
    assert.equal(account.status, 'error')
    assert.match(account.lastError ?? '', /English/)
  })

  it('without a readable own profile, our own messages are never taken for replies', async () => {
    const userId = addUser(db)
    site.meBroken = true
    try {
      const out = await svc.connectWithCookie(userId, site.newSession())
      assert.equal(out.account.status, 'connected', out.message)
      assert.equal(out.account.profile?.profileUrl, '')
    } finally {
      site.meBroken = false
    }
    const lead = person('lead-own-name', { state: 'connected', thread: [{ from: 'me', text: 'Hi Jane, campaign message' }] })
    assert.equal(await svc.withDriver(userId, (d) => d.hasReplied(lead, { after: null })), false)
    assert.equal(await svc.withDriver(userId, (d) => d.sendMessage(lead, 'Follow-up', { stopIfRepliedAfter: { after: 'Hi Jane, campaign message' } })), 'sent')
  })

  it('a browser that cannot start is a transient problem', async () => {
    const userId = addUser(db)
    await svc.connectWithCookie(userId, site.newSession())
    const broken = service({
      setupContext: () => {
        throw new Error('Chromium crashed while starting')
      },
    })
    await assert.rejects(
      broken.withDriver(userId, async () => 1),
      (e: unknown) => e instanceof LinkedInError && e.code === 'transient' && /Could not start the browser/.test(e.message),
    )
    assert.equal(readAccount(db, userId).status, 'connected', 'the account is fine')
  })
})

describe('Playwright LinkedIn service: memory', () => {
  it('MAX_BROWSER_CONTEXTS defaults to 3', () => {
    assert.equal(maxContextsFromEnv({}), 3)
    assert.equal(maxContextsFromEnv({ MAX_BROWSER_CONTEXTS: '5' }), 5)
    assert.equal(maxContextsFromEnv({ MAX_BROWSER_CONTEXTS: '0' }), 3)
    assert.equal(maxContextsFromEnv({ MAX_BROWSER_CONTEXTS: 'lots' }), 3)
  })

  it('keeps at most maxContexts contexts open, closing the least recently used idle one', async () => {
    const capped = service({ maxContexts: 2 })
    const users = [addUser(db), addUser(db), addUser(db)]
    for (const u of users) {
      assert.equal((await capped.connectWithCookie(u, site.newSession())).account.status, 'connected')
      assert.ok(capped.openContexts <= 2, `open: ${capped.openContexts}`)
    }
    // Every user still works: an evicted session is rebuilt from the database.
    for (const u of [...users, users[0]]) {
      assert.equal(await capped.withDriver(u, (d) => d.getConnectionStatus(person('lead-cap', { state: 'connected' }))), 'connected')
      assert.ok(capped.openContexts <= 2, `open: ${capped.openContexts}`)
    }
  })

  it('engine work waits for a busy context to free up, and gives up as transient', async () => {
    const one = service({ maxContexts: 1, capacityWaitMs: 400 })
    const [a, b] = [addUser(db), addUser(db)]
    await one.connectWithCookie(a, site.newSession())
    await one.connectWithCookie(b, site.newSession())
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const busy = one.withDriver(a, () => held)
    await sleep(200)
    await rejectsWith(one.withDriver(b, async () => 1), 'transient')
    const waiting = one.withDriver(b, async () => 'b ran')
    await sleep(100)
    release()
    await busy
    assert.equal(await waiting, 'b ran')
    assert.equal(one.openContexts, 1)
  })
})
