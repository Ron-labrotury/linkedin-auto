import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { one, run } from '../src/db/index.ts'
import { sha256 } from '../src/crypto.ts'
import { DEFAULT_SETTINGS } from '../../shared/time.ts'
import { type TestApi, startApi } from './helpers/api-server.ts'

describe('auth API', () => {
  let api: TestApi
  before(async () => {
    api = await startApi()
  })
  after(() => api.close())

  it('signs up: creates workspace, owner, default settings and a disconnected LinkedIn account', async () => {
    const res = await api.call('POST', '/api/auth/signup', { body: { name: '  Ada Lovelace ', email: ' Ada@Example.COM ', password: 'analytical1' } })
    assert.equal(res.status, 201)
    assert.equal(typeof res.body.token, 'string')
    const user = res.body.user
    assert.equal(user.email, 'ada@example.com')
    assert.equal(user.name, 'Ada Lovelace')
    assert.equal(user.role, 'owner')
    assert.match(user.createdAt, /^\d{4}-\d\d-\d\dT/)

    const ws = one<{ name: string }>(api.db, 'SELECT name FROM workspaces WHERE id = ?', user.workspaceId)
    assert.equal(ws?.name, "Ada Lovelace's workspace")
    const row = one<{ password_hash: string }>(api.db, 'SELECT password_hash FROM users WHERE id = ?', user.id)!
    assert.match(row.password_hash, /^scrypt\$16384\$8\$1\$[^$]+\$[^$]+$/)
    const acc = one<{ status: string; updated_at: number }>(api.db, 'SELECT status, updated_at FROM linkedin_accounts WHERE user_id = ?', user.id)
    assert.equal(acc?.status, 'disconnected')
    assert.ok(acc!.updated_at > 0)
    const session = one<{ token_hash: string }>(api.db, 'SELECT token_hash FROM sessions WHERE user_id = ?', user.id)
    assert.equal(session?.token_hash, sha256(res.body.token))

    const settings = await api.call('GET', '/api/settings', { token: res.body.token })
    assert.deepEqual(settings.body, DEFAULT_SETTINGS)
  })

  it('rejects invalid signups with field details', async () => {
    const bad = await api.call('POST', '/api/auth/signup', { body: { name: '', email: 'not-an-email', password: 'short' } })
    assert.equal(bad.status, 400)
    assert.ok(bad.body.error)
    assert.ok(bad.body.details.name)
    assert.ok(bad.body.details.email)
    assert.ok(bad.body.details.password)

    const long = await api.call('POST', '/api/auth/signup', { body: { name: 'x'.repeat(81), email: 'long@example.com', password: 'longenough' } })
    assert.equal(long.status, 400)
    assert.ok(long.body.details.name)

    const empty = await api.call('POST', '/api/auth/signup')
    assert.equal(empty.status, 400)
  })

  it('rejects a duplicate email (case-insensitive) with 409', async () => {
    await api.signup({ email: 'dup@example.com' })
    const res = await api.call('POST', '/api/auth/signup', { body: { name: 'Dup', email: 'DUP@example.com', password: 'password123' } })
    assert.equal(res.status, 409)
    assert.equal(one<{ n: number }>(api.db, `SELECT COUNT(*) AS n FROM users WHERE email = 'dup@example.com'`)!.n, 1)
  })

  it('logs in, returns the user, and rejects wrong credentials with 401', async () => {
    const { user } = await api.signup({ email: 'login@example.com', password: 'secret-pass' })
    const ok = await api.call('POST', '/api/auth/login', { body: { email: ' LOGIN@example.com', password: 'secret-pass' } })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.user.id, user.id)

    const me = await api.call('GET', '/api/auth/me', { token: ok.body.token })
    assert.equal(me.status, 200)
    assert.deepEqual(me.body, user)

    const wrong = await api.call('POST', '/api/auth/login', { body: { email: 'login@example.com', password: 'nope-nope' } })
    assert.equal(wrong.status, 401)
    assert.equal(wrong.body.error, 'Invalid email or password')
    const unknown = await api.call('POST', '/api/auth/login', { body: { email: 'ghost@example.com', password: 'whatever1' } })
    assert.equal(unknown.status, 401)
    assert.equal(unknown.body.error, 'Invalid email or password')
  })

  it('requires a valid bearer token on protected routes', async () => {
    for (const [method, path] of [
      ['GET', '/api/auth/me'],
      ['GET', '/api/settings'],
      ['GET', '/api/linkedin'],
      ['GET', '/api/campaigns'],
      ['GET', '/api/dashboard'],
      ['GET', '/api/team'],
      ['POST', '/api/auth/logout'],
    ]) {
      const res = await api.call(method, path)
      assert.equal(res.status, 401, `${method} ${path}`)
      assert.ok(res.body.error)
    }
    const bogus = await api.call('GET', '/api/auth/me', { token: 'not-a-real-token' })
    assert.equal(bogus.status, 401)
    const basic = await api.call('GET', '/api/auth/me', { headers: { Authorization: 'Basic abc' } })
    assert.equal(basic.status, 401)
  })

  it('rejects and deletes expired sessions; slides sessions near expiry', async () => {
    const { token, user } = await api.signup()
    const hash = sha256(token)
    run(api.db, 'UPDATE sessions SET expires_at = ? WHERE token_hash = ?', Date.now() - 1, hash)
    const res = await api.call('GET', '/api/auth/me', { token })
    assert.equal(res.status, 401)
    assert.equal(one(api.db, 'SELECT 1 FROM sessions WHERE token_hash = ?', hash), undefined)

    const login = await api.call('POST', '/api/auth/login', { body: { email: user.email, password: 'correct horse battery' } })
    const h2 = sha256(login.body.token)
    const soon = Date.now() + 60_000
    run(api.db, 'UPDATE sessions SET expires_at = ? WHERE token_hash = ?', soon, h2)
    assert.equal((await api.call('GET', '/api/auth/me', { token: login.body.token })).status, 200)
    const after = one<{ expires_at: number }>(api.db, 'SELECT expires_at FROM sessions WHERE token_hash = ?', h2)!
    assert.ok(after.expires_at > soon + api.config.sessionTtlMs / 2)
  })

  it('logs out by deleting the session', async () => {
    const { token } = await api.signup()
    const out = await api.call('POST', '/api/auth/logout', { token })
    assert.equal(out.status, 204)
    assert.equal((await api.call('GET', '/api/auth/me', { token })).status, 401)
  })

  it('updates the name', async () => {
    const { token } = await api.signup()
    const res = await api.call('PATCH', '/api/auth/me', { token, body: { name: '  Grace Hopper  ' } })
    assert.equal(res.status, 200)
    assert.equal(res.body.name, 'Grace Hopper')
    const bad = await api.call('PATCH', '/api/auth/me', { token, body: { name: '   ' } })
    assert.equal(bad.status, 400)
    assert.ok(bad.body.details.name)
  })

  it('changes the password and revokes other sessions', async () => {
    const { token, user } = await api.signup({ password: 'first-password' })
    const other = await api.call('POST', '/api/auth/login', { body: { email: user.email, password: 'first-password' } })
    assert.equal(other.status, 200)

    const wrong = await api.call('POST', '/api/auth/password', { token, body: { currentPassword: 'nope-nope', newPassword: 'second-password' } })
    assert.equal(wrong.status, 400)
    assert.ok(wrong.body.details.currentPassword)
    const tooShort = await api.call('POST', '/api/auth/password', { token, body: { currentPassword: 'first-password', newPassword: 'short' } })
    assert.equal(tooShort.status, 400)
    assert.ok(tooShort.body.details.newPassword)

    const ok = await api.call('POST', '/api/auth/password', { token, body: { currentPassword: 'first-password', newPassword: 'second-password' } })
    assert.equal(ok.status, 204)
    assert.equal((await api.call('GET', '/api/auth/me', { token })).status, 200, 'current session survives')
    assert.equal((await api.call('GET', '/api/auth/me', { token: other.body.token })).status, 401, 'other session revoked')
    assert.equal((await api.call('POST', '/api/auth/login', { body: { email: user.email, password: 'first-password' } })).status, 401)
    assert.equal((await api.call('POST', '/api/auth/login', { body: { email: user.email, password: 'second-password' } })).status, 200)
  })

  it('limits wrong current passwords on POST /auth/password to 5 per user per 15 min', async () => {
    const { token, user } = await api.signup({ password: 'first-password' })
    const change = (currentPassword: string, t = token) =>
      api.call('POST', '/api/auth/password', { token: t, body: { currentPassword, newPassword: 'stolen-account' } })

    // a success clears earlier failures
    for (let i = 0; i < 4; i++) assert.equal((await change(`guess-${i}`)).status, 400)
    const ok = await api.call('POST', '/api/auth/password', { token, body: { currentPassword: 'first-password', newPassword: 'second-password' } })
    assert.equal(ok.status, 204)

    // a stolen token is not an unlimited password oracle: the 6th attempt is refused, even with the right password
    for (let i = 0; i < 5; i++) assert.equal((await change(`guess-${i}`)).status, 400)
    const blocked = await change('second-password')
    assert.equal(blocked.status, 429)
    assert.match(blocked.body.error, /Too many incorrect password attempts/)
    assert.ok(Number(blocked.headers.get('retry-after')) > 0)
    // per user, across sessions: another session of the same user is blocked too
    const other = await api.call('POST', '/api/auth/login', { body: { email: user.email, password: 'second-password' } })
    assert.equal((await change('second-password', other.body.token)).status, 429)
    // the password was not changed and the session still works
    assert.equal((await api.call('GET', '/api/auth/me', { token })).status, 200)
    assert.equal((await api.call('POST', '/api/auth/login', { body: { email: user.email, password: 'second-password' } })).status, 200)

    // concurrent guesses can't slip past the limit either
    const racer = await api.signup({ password: 'racer-password' })
    const raced = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        api.call('POST', '/api/auth/password', { token: racer.token, body: { currentPassword: `guess-${i}`, newPassword: 'stolen-account' } }),
      ),
    )
    assert.deepEqual(
      raced.map((r) => r.status).sort(),
      [...Array(5).fill(400), ...Array(7).fill(429)],
    )

    // other users are not affected
    const someone = await api.signup({ password: 'their-password' })
    const theirs = await api.call('POST', '/api/auth/password', {
      token: someone.token,
      body: { currentPassword: 'their-password', newPassword: 'their-new-password' },
    })
    assert.equal(theirs.status, 204)
  })

  it('rate-limits failed logins per email + IP (10 per 15 min)', async () => {
    const { user } = await api.signup({ email: 'victim@example.com', password: 'the-real-one' })
    const ip = { 'X-Forwarded-For': '203.0.113.7' }
    for (let i = 0; i < 10; i++) {
      const res = await api.call('POST', '/api/auth/login', { headers: ip, body: { email: user.email, password: `wrong-${i}` } })
      assert.equal(res.status, 401)
    }
    const blocked = await api.call('POST', '/api/auth/login', { headers: ip, body: { email: 'VICTIM@example.com', password: 'the-real-one' } })
    assert.equal(blocked.status, 429)
    assert.ok(Number(blocked.headers.get('retry-after')) > 0)
    assert.match(blocked.body.error, /Too many/)

    const otherIp = await api.call('POST', '/api/auth/login', {
      headers: { 'X-Forwarded-For': '198.51.100.1' },
      body: { email: user.email, password: 'the-real-one' },
    })
    assert.equal(otherIp.status, 200)
    const otherEmail = await api.call('POST', '/api/auth/login', { headers: ip, body: { email: 'someone@example.com', password: 'x-x-x-x-x' } })
    assert.equal(otherEmail.status, 401)
  })
})
