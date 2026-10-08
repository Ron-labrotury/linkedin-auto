import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { one, run } from '../src/db/index.ts'
import { clearAccount, getAccount, loadSession, markExpired, readAccount, UNREADABLE_SESSION, updateAccount } from '../src/linkedin/accounts.ts'
import { addUser, testDb } from './helpers/linkedin-db.ts'

const profile = { name: 'Sam Sender', headline: 'Founder', profileUrl: 'https://www.linkedin.com/in/sam-sender/', imageUrl: null }

describe('linkedin accounts persistence', () => {
  it('reads a missing row as disconnected and upserts on write', () => {
    const db = testDb()
    const userId = addUser(db, { withAccountRow: false })
    assert.deepEqual(getAccount(db, userId), {
      status: 'disconnected',
      authMethod: null,
      email: null,
      profile: null,
      lastCheckedAt: null,
      lastError: null,
    })
    const account = updateAccount(db, userId, { status: 'connected', authMethod: 'password', email: 'sam@example.com', profile, session: { cookies: [] }, lastCheckedAt: 1_700_000_000_000 })
    assert.equal(account.status, 'connected')
    assert.equal(account.authMethod, 'password')
    assert.equal(account.email, 'sam@example.com')
    assert.deepEqual(account.profile, profile)
    assert.equal(account.lastCheckedAt, new Date(1_700_000_000_000).toISOString())
    assert.equal(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM linkedin_accounts WHERE user_id = ?', userId)!.n, 1)
  })

  it('stores the session only encrypted and round-trips it', () => {
    const db = testDb()
    const userId = addUser(db)
    const session = { cookies: [{ name: 'li_at', value: 'AQEDARsecretcookie', domain: '.linkedin.com' }], origins: [] }
    updateAccount(db, userId, { status: 'connected', session })
    const raw = one<{ session_enc: string }>(db, 'SELECT session_enc FROM linkedin_accounts WHERE user_id = ?', userId)!.session_enc
    assert.match(raw, /^v1\./)
    assert.ok(!raw.includes('AQEDARsecretcookie'))
    assert.deepEqual(loadSession(db, userId), session)
    // Undefined fields are left alone.
    updateAccount(db, userId, { lastError: 'x' })
    assert.deepEqual(loadSession(db, userId), session)
  })

  it('treats an undecryptable session as expired (and clears it)', () => {
    const db = testDb()
    const userId = addUser(db)
    updateAccount(db, userId, { status: 'connected', profile, session: { cookies: [] } })
    run(db, `UPDATE linkedin_accounts SET session_enc = 'v1.AAAA.BBBB.CCCC' WHERE user_id = ?`, userId)
    const account = getAccount(db, userId)
    assert.equal(account.status, 'expired')
    assert.equal(account.lastError, UNREADABLE_SESSION)
    assert.deepEqual(account.profile, profile, 'the profile is kept')
    assert.equal(loadSession(db, userId), null)
    assert.equal(one<{ session_enc: string | null }>(db, 'SELECT session_enc FROM linkedin_accounts WHERE user_id = ?', userId)!.session_enc, null)
  })

  it('loadSession marks the account expired when the stored session is corrupt', () => {
    const db = testDb()
    const userId = addUser(db)
    updateAccount(db, userId, { status: 'connected', session: { cookies: [] } })
    run(db, `UPDATE linkedin_accounts SET session_enc = 'garbage' WHERE user_id = ?`, userId)
    assert.equal(loadSession(db, userId), null)
    assert.equal(readAccount(db, userId).status, 'expired')
  })

  it('a connected account without any session reads as expired', () => {
    const db = testDb()
    const userId = addUser(db)
    updateAccount(db, userId, { status: 'connected' })
    assert.equal(getAccount(db, userId).status, 'expired')
  })

  it('markExpired keeps the profile; clearAccount forgets session and profile', () => {
    const db = testDb()
    const userId = addUser(db)
    updateAccount(db, userId, { status: 'connected', authMethod: 'cookie', profile, session: { cookies: [] } })
    const expired = markExpired(db, userId, 'LinkedIn signed you out')
    assert.equal(expired.status, 'expired')
    assert.equal(expired.lastError, 'LinkedIn signed you out')
    assert.deepEqual(expired.profile, profile)
    assert.deepEqual(loadSession(db, userId), { cookies: [] })

    const cleared = clearAccount(db, userId)
    assert.equal(cleared.status, 'disconnected')
    assert.equal(cleared.profile, null)
    assert.equal(cleared.authMethod, null)
    assert.equal(cleared.lastError, null)
    assert.equal(loadSession(db, userId), null)
  })
})
