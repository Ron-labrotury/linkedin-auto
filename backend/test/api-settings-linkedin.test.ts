import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { one } from '../src/db/index.ts'
import { type TestApi, startApi } from './helpers/api-server.ts'

const valid = {
  timezone: 'America/New_York',
  activeDays: [5, 1, 3, 1],
  activeStart: '08:30',
  activeEnd: '17:00',
  gapMinMinutes: 1,
  gapMaxMinutes: 5,
}

describe('settings API', () => {
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

  it('saves active hours and the random gap (days de-duplicated and sorted)', async () => {
    const res = await api.call('PUT', '/api/settings', { token, body: { ...valid, extra: 'ignored' } })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ...valid, activeDays: [1, 3, 5] })
    assert.deepEqual((await api.call('GET', '/api/settings', { token })).body, res.body)
    const row = one<{ active_days_json: string; timezone: string }>(api.db, 'SELECT * FROM user_settings WHERE user_id = ?', userId)!
    assert.equal(row.active_days_json, '[1,3,5]')
    assert.equal(row.timezone, 'America/New_York')
  })

  it('rejects invalid settings with per-field details', async () => {
    const res = await api.call('PUT', '/api/settings', {
      token,
      body: { timezone: 'Mars/Olympus', activeDays: [], activeStart: '9am', activeEnd: '25:00', gapMinMinutes: 5, gapMaxMinutes: 2 },
    })
    assert.equal(res.status, 400)
    assert.deepEqual(Object.keys(res.body.details).sort(), ['activeDays', 'activeEnd', 'activeStart', 'gapMaxMinutes', 'timezone'])

    const order = await api.call('PUT', '/api/settings', { token, body: { ...valid, activeStart: '18:00', activeEnd: '09:00' } })
    assert.equal(order.status, 400)
    assert.equal(order.body.details.activeEnd, 'End must be after start')

    const types = await api.call('PUT', '/api/settings', { token, body: { ...valid, activeStart: ['09:00'], gapMinMinutes: '1', activeDays: [1.5] } })
    assert.equal(types.status, 400)
    assert.ok(types.body.details.activeStart)
    assert.ok(types.body.details.gapMinMinutes)
    assert.ok(types.body.details.activeDays)

    const tooLong = await api.call('PUT', '/api/settings', { token, body: { ...valid, gapMaxMinutes: 500 } })
    assert.equal(tooLong.status, 400)
    assert.ok(tooLong.body.details.gapMaxMinutes)
  })
})

describe('settings API: time zones', () => {
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

  const put = (timezone: unknown) => api.call('PUT', '/api/settings', { token, body: { ...valid, timezone } })
  const stored = () => one<{ timezone: string }>(api.db, 'SELECT timezone FROM user_settings WHERE user_id = ?', userId)!.timezone

  it('validates with isValidTimeZone and stores the zone as given (trimmed)', async () => {
    const res = await put('  asia/KOLKATA ')
    assert.equal(res.status, 200)
    assert.equal(res.body.timezone, 'asia/KOLKATA')
    assert.equal(stored(), 'asia/KOLKATA')
    assert.equal((await put('UTC')).status, 200)
    assert.equal((await put('Europe/Berlin')).status, 200)
    assert.equal(stored(), 'Europe/Berlin')
  })

  it('rejects unknown, non-string and overlong zones', async () => {
    for (const tz of ['Mars/Olympus', '', '   ', 42, null, `America/${'x'.repeat(60)}`, 'America/Argentina/ComodRivadavia'.padEnd(65, '_')]) {
      const res = await put(tz)
      assert.equal(res.status, 400, String(tz))
      assert.equal(res.body.details.timezone, 'Unknown time zone')
    }
    assert.equal(stored(), 'Europe/Berlin', 'nothing was saved')
  })

  it('accepts other spellings of a zone, and the dashboard works with them', async () => {
    const zone = 'America/Argentina/ComodRivadavia'
    for (let i = 0; i < 20; i++) {
      const variant = [...zone].map((c, j) => ((i >> j % 6) & 1 ? c.toUpperCase() : c.toLowerCase())).join('')
      assert.equal((await put(variant)).status, 200, variant)
    }
    assert.equal((await api.call('GET', '/api/dashboard', { token })).status, 200)
  })
})

describe('linkedin API', () => {
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

  it('returns the account', async () => {
    const res = await api.call('GET', '/api/linkedin', { token })
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'disconnected')
  })

  it('logs in with password → verification code → connected', async () => {
    const login = await api.call('POST', '/api/linkedin/login', { token, body: { email: ' me@corp.com ', password: 'needs-code' } })
    assert.equal(login.status, 200)
    assert.equal(login.body.account.status, 'needs_verification')
    assert.ok(login.body.message)
    const call = api.linkedin.calls.at(-1)!
    assert.deepEqual(call, { method: 'loginWithPassword', userId, args: ['me@corp.com', 'needs-code'] })

    const badCode = await api.call('POST', '/api/linkedin/verify', { token, body: { code: '12a' } })
    assert.equal(badCode.status, 400)
    assert.ok(badCode.body.details.code)

    const wrong = await api.call('POST', '/api/linkedin/verify', { token, body: { code: '000000' } })
    assert.equal(wrong.status, 400)
    assert.equal(wrong.body.error, 'That code is not correct')

    const ok = await api.call('POST', '/api/linkedin/verify', { token, body: { code: ' 123 456 ' } })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.account.status, 'connected')
    assert.deepEqual(api.linkedin.calls.at(-1)!.args, ['123456'])
  })

  it('checks a pending app approval', async () => {
    await api.call('POST', '/api/linkedin/login', { token, body: { email: 'me@corp.com', password: 'needs-app' } })
    const res = await api.call('POST', '/api/linkedin/check', { token })
    assert.equal(res.status, 200)
    assert.equal(res.body.account.status, 'connected')
  })

  it('validates login input', async () => {
    const res = await api.call('POST', '/api/linkedin/login', { token, body: { email: '', password: '' } })
    assert.equal(res.status, 400)
    assert.ok(res.body.details.email)
    assert.ok(res.body.details.password)
  })

  it('connects with an li_at cookie (prefix and quotes stripped) and validates length', async () => {
    const short = await api.call('POST', '/api/linkedin/cookie', { token, body: { liAt: 'abc' } })
    assert.equal(short.status, 400)
    assert.ok(short.body.details.liAt)
    const tooLong = await api.call('POST', '/api/linkedin/cookie', { token, body: { liAt: 'x'.repeat(4001) } })
    assert.equal(tooLong.status, 400)

    const value = 'AQEDARabcdefghijklmnop'
    const res = await api.call('POST', '/api/linkedin/cookie', { token, body: { liAt: ` li_at="${value}"; ` } })
    assert.equal(res.status, 200)
    assert.equal(res.body.account.authMethod, 'cookie')
    assert.deepEqual(api.linkedin.calls.at(-1)!.args, [value])
  })

  it('tests the connection (the Settings "Test" button)', async () => {
    const res = await api.call('POST', '/api/linkedin/test', { token })
    assert.equal(res.status, 200)
    assert.deepEqual(Object.keys(res.body).sort(), ['account', 'message', 'ok'])
    assert.equal(res.body.ok, true)
  })

  it('maps service errors to 400 with the service message', async () => {
    api.linkedin.failWith = new Error('LinkedIn is asking for a captcha')
    const res = await api.call('POST', '/api/linkedin/login', { token, body: { email: 'me@corp.com', password: 'pw' } })
    assert.equal(res.status, 400)
    assert.equal(res.body.error, 'LinkedIn is asking for a captcha')
  })

  it('disconnects', async () => {
    const res = await api.call('DELETE', '/api/linkedin', { token })
    assert.equal(res.status, 204)
    assert.equal(api.linkedin.calls.at(-1)!.method, 'disconnect')
    assert.equal((await api.call('GET', '/api/linkedin', { token })).body.status, 'disconnected')
    const test = await api.call('POST', '/api/linkedin/test', { token })
    assert.equal(test.body.ok, false)
  })
})
