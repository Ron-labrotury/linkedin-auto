import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hashPassword, verifyPassword } from '../src/auth/password.ts'
import { createFailureWindow, createLoginLimiter, ipBucket } from '../src/auth/rate-limit.ts'
import { jsonEqual } from '../src/repo/util.ts'
import { type TestApi, startApi } from './helpers/api-server.ts'

describe('http basics', () => {
  let api: TestApi
  before(async () => {
    api = await startApi()
  })
  after(() => api.close())

  it('GET /api/health reports the driver', async () => {
    const res = await api.call('GET', '/api/health')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true, driver: 'simulated' })
  })

  it('sets security headers and no-store on API responses', async () => {
    const res = await api.call('GET', '/api/health')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('x-frame-options'), 'DENY')
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(res.headers.get('x-powered-by'), null)
  })

  it('answers unknown API routes with a JSON 404 (with or without auth)', async () => {
    const res = await api.call('GET', '/api/nope')
    assert.equal(res.status, 404)
    assert.deepEqual(res.body, { error: 'Not found' })
    const { token } = await api.signup()
    assert.equal((await api.call('GET', '/api/campaigns/x/unknown', { token })).status, 404)
    assert.equal((await api.call('PUT', '/api/dashboard', { token })).status, 404)
    assert.equal((await api.call('GET', '/not-api')).status, 404)
  })

  it('rejects malformed JSON with 400 and oversized bodies with 413', async () => {
    const bad = await api.call('POST', '/api/auth/login', { raw: '{"email": ' })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error, 'Request body is not valid JSON')
    const big = await api.call('POST', '/api/auth/login', { raw: JSON.stringify({ email: 'x'.repeat(6 * 1024 * 1024) }) })
    assert.equal(big.status, 413)
    assert.ok(big.body.error)
  })

  it('answers malformed percent-encoding in the path with a JSON 400 and logs no stack trace', async () => {
    const logged: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => void logged.push(args)
    try {
      const invite = await api.call('GET', '/api/auth/invite/%ZZ')
      assert.equal(invite.status, 400)
      assert.deepEqual(invite.body, { error: 'Malformed URL' })
      const { token } = await api.signup()
      for (const path of ['/api/campaigns/%E0%A4%A', '/api/campaigns/%ZZ/leads', '/api/team/members/%']) {
        const res = await api.call(path.includes('team') ? 'DELETE' : 'GET', path, { token })
        assert.equal(res.status, 400, path)
        assert.deepEqual(res.body, { error: 'Malformed URL' })
      }
    } finally {
      console.error = original
    }
    assert.deepEqual(logged, [])
  })

  it('handles CORS preflight for any origin by default', async () => {
    const res = await fetch(`${api.url}/api/campaigns`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://frontend.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
    })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    assert.match(res.headers.get('access-control-allow-headers') ?? '', /authorization/i)
  })
})

describe('restricted CORS + static frontend', () => {
  let api: TestApi
  let dist: string
  before(async () => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'api-dist-'))
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>app</title>')
    fs.mkdirSync(path.join(dist, 'assets'))
    fs.writeFileSync(path.join(dist, 'assets', 'app-123.js'), 'console.log(1)')
    api = await startApi({ corsOrigins: ['https://app.example.com'], frontendDist: dist })
  })
  after(async () => {
    await api.close()
    fs.rmSync(dist, { recursive: true, force: true })
  })

  it('only allows configured origins', async () => {
    const ok = await api.call('GET', '/api/health', { headers: { Origin: 'https://app.example.com' } })
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://app.example.com')
    const other = await api.call('GET', '/api/health', { headers: { Origin: 'https://evil.example' } })
    assert.equal(other.headers.get('access-control-allow-origin'), null)
  })

  it('serves assets and falls back to index.html for client routes, but not for /api', async () => {
    const asset = await api.call('GET', '/assets/app-123.js')
    assert.equal(asset.status, 200)
    assert.match(asset.headers.get('cache-control') ?? '', /immutable/)
    for (const p of ['/', '/campaigns/cmp_1', '/settings?tab=x']) {
      const res = await api.call('GET', p)
      assert.equal(res.status, 200, p)
      assert.match(String(res.body), /<title>app<\/title>/)
      assert.match(res.headers.get('content-type') ?? '', /text\/html/)
    }
    const apiMiss = await api.call('GET', '/api/does-not-exist')
    assert.equal(apiMiss.status, 404)
    assert.deepEqual(apiMiss.body, { error: 'Not found' })
    assert.equal((await api.call('POST', '/somewhere')).status, 404)
  })
})

describe('client IP for the login limit (trust proxy)', () => {
  const login = (api: TestApi, email: string, password: string, xff?: string) =>
    api.call('POST', '/api/auth/login', { headers: xff ? { 'X-Forwarded-For': xff } : {}, body: { email, password } })

  it('behind one proxy, only the address the proxy appended counts (a spoofed X-Forwarded-For prefix is ignored)', async () => {
    const api = await startApi({ trustProxy: 1 })
    try {
      const { user } = await api.signup({ password: 'the-real-one' })
      // the attacker rotates the left-most (client supplied) value; the proxy appends their real address
      for (let i = 0; i < 10; i++) assert.equal((await login(api, user.email, `wrong-${i}`, `10.0.0.${i}, 203.0.113.50`)).status, 401)
      assert.equal((await login(api, user.email, 'wrong', `9.9.9.9, 203.0.113.50`)).status, 429)
      assert.equal((await login(api, user.email, 'wrong', `${'1'.repeat(15_000)}, 203.0.113.50`)).status, 429)
      // the account owner, from their own address, is not locked out
      assert.equal((await login(api, user.email, 'the-real-one', '198.51.100.2')).status, 200)
    } finally {
      await api.close()
    }
  })

  it('concurrent attempts cannot slip past the limit', async () => {
    const api = await startApi()
    try {
      const { user } = await api.signup({ password: 'the-real-one' })
      const results = await Promise.all(Array.from({ length: 25 }, (_, i) => login(api, user.email, `wrong-${i}`, '203.0.113.77')))
      const statuses = results.map((r) => r.status)
      assert.equal(statuses.filter((s) => s === 401).length, 10, statuses.join(','))
      assert.equal(statuses.filter((s) => s === 429).length, 15)
    } finally {
      await api.close()
    }
  })

  it('without a trusted proxy, X-Forwarded-For is ignored entirely', async () => {
    const api = await startApi({ trustProxy: false })
    try {
      const { user } = await api.signup({ password: 'the-real-one' })
      for (let i = 0; i < 10; i++) assert.equal((await login(api, user.email, `wrong-${i}`, `10.0.0.${i}`)).status, 401)
      const blocked = await login(api, user.email, 'the-real-one', '198.51.100.3')
      assert.equal(blocked.status, 429, 'every request came from 127.0.0.1')
    } finally {
      await api.close()
    }
  })
})

describe('password hashing', () => {
  it('hashes with scrypt and verifies', async () => {
    const h = await hashPassword('hunter2-hunter2')
    const [alg, n, r, p, salt, key] = h.split('$')
    assert.deepEqual([alg, n, r, p], ['scrypt', '16384', '8', '1'])
    assert.equal(Buffer.from(salt, 'base64').length, 16)
    assert.equal(Buffer.from(key, 'base64').length, 64)
    assert.equal(await verifyPassword('hunter2-hunter2', h), true)
    assert.equal(await verifyPassword('hunter2-hunter3', h), false)
    assert.notEqual(await hashPassword('hunter2-hunter2'), h, 'random salt')
  })

  it('treats malformed or hostile hashes as non-matching', async () => {
    for (const bad of ['', 'plain', 'scrypt$1$8$1$abc$def', 'scrypt$16384$8$1$$', 'bcrypt$16384$8$1$YWJj$ZGVm', 'scrypt$1048577$8$1$YWJjZGVm$YWJjZGVmYWJjZGVmYWJjZGVm'])
      assert.equal(await verifyPassword('x', bad), false, bad)
  })
})

describe('login limiter', () => {
  it('blocks after 10 failures per email+ip within the window, then recovers', () => {
    let t = 1_000_000
    const lim = createLoginLimiter({ now: () => t })
    for (let i = 0; i < 9; i++) lim.fail('A@x.com', '1.1.1.1')
    assert.equal(lim.blockedFor('a@x.com', '1.1.1.1'), 0)
    lim.fail('a@x.com', '1.1.1.1')
    assert.equal(lim.blockedFor('a@x.com', '1.1.1.1'), 15 * 60_000)
    assert.equal(lim.blockedFor('a@x.com', '2.2.2.2'), 0, 'other ip')
    assert.equal(lim.blockedFor('b@x.com', '1.1.1.1'), 0, 'other email')
    t += 15 * 60_000
    assert.equal(lim.blockedFor('a@x.com', '1.1.1.1'), 0, 'window passed')
  })

  it('caps one IP across emails (password spraying) at 100 per window', () => {
    let t = 0
    const lim = createLoginLimiter({ now: () => t })
    for (let i = 0; i < 99; i++) lim.fail(`u${i}@x.com`, '6.6.6.6')
    assert.equal(lim.blockedFor('fresh@x.com', '6.6.6.6'), 0)
    lim.fail('u99@x.com', '6.6.6.6')
    assert.ok(lim.blockedFor('fresh@x.com', '6.6.6.6') > 0, 'every email blocked from that ip')
    assert.equal(lim.blockedFor('fresh@x.com', '7.7.7.7'), 0, 'other ips are not affected')
    t += 15 * 60_000
    assert.equal(lim.blockedFor('fresh@x.com', '6.6.6.6'), 0)
  })

  it('caps one email across IPs at 100, but not for a device that signed in before', () => {
    let t = 0
    const lim = createLoginLimiter({ now: () => t })
    // the owner signed in from home earlier
    lim.reset('victim@x.com', '198.51.100.1')
    t += 60_000
    // a distributed attack: 10 addresses x 10 failures (each pair stays at its own limit of 10)
    for (let ip = 0; ip < 10; ip++) for (let i = 0; i < 10; i++) lim.fail('victim@x.com', `10.0.0.${ip}`)
    assert.ok(lim.blockedFor('victim@x.com', '10.0.9.9') > 0, 'new addresses are blocked for that email')
    assert.equal(lim.blockedFor('victim@x.com', '198.51.100.1'), 0, 'the owner can still sign in from a known device')
    assert.equal(lim.blockedFor('other@x.com', '10.0.0.1'), 0, 'other emails are not affected')
    // a remembered device still has its own per-pair limit
    for (let i = 0; i < 10; i++) lim.fail('victim@x.com', '198.51.100.1')
    assert.ok(lim.blockedFor('victim@x.com', '198.51.100.1') > 0)
    // 100 failures from 99 addresses are not enough to lock the account
    const l2 = createLoginLimiter({ now: () => t })
    for (let i = 0; i < 99; i++) l2.fail('v2@x.com', `10.1.0.${i}`)
    assert.equal(l2.blockedFor('v2@x.com', '10.2.0.1'), 0)
  })

  it('a successful login clears that pair and does not count towards the wide caps', () => {
    const lim = createLoginLimiter({ now: () => 1 })
    for (let i = 0; i < 10; i++) lim.fail('u@x.com', '1.1.1.1')
    assert.ok(lim.blockedFor('u@x.com', '1.1.1.1') > 0)
    lim.reset('u@x.com', '1.1.1.1')
    assert.equal(lim.blockedFor('u@x.com', '1.1.1.1'), 0)
    // an office behind one address: 99 typos + 50 successful sign-ins (each counted up front, then taken back)
    const office = createLoginLimiter({ now: () => 1 })
    for (let i = 0; i < 99; i++) office.fail(`typo${i}@x.com`, '5.5.5.5')
    for (let i = 0; i < 50; i++) {
      office.fail(`ok${i}@x.com`, '5.5.5.5')
      office.reset(`ok${i}@x.com`, '5.5.5.5')
    }
    assert.equal(office.blockedFor('someone@x.com', '5.5.5.5'), 0)
  })

  it('evicts the least recent keys beyond maxKeys', () => {
    const lim = createLoginLimiter({ maxKeys: 4, maxPerPair: 1 })
    lim.fail('first@x.com', '1')
    for (let i = 0; i < 10; i++) lim.fail(`u${i}@x.com`, String(i + 2))
    assert.equal(lim.blockedFor('first@x.com', '1'), 0)
    assert.ok(lim.blockedFor('u9@x.com', '11') > 0)
  })

  it('keeps memory bounded: expired keys are pruned and each key keeps at most `max` timestamps', () => {
    let t = 0
    const w = createFailureWindow({ max: 3, windowMs: 1000, maxKeys: 100, now: () => t })
    for (let i = 0; i < 50; i++) w.fail(`k${i}`)
    assert.equal(w.size, 50)
    t += 1000
    w.fail('new')
    assert.equal(w.size, 1, 'expired keys are dropped on the next failure')
    for (let i = 0; i < 500; i++) w.fail(`k${i}`)
    assert.equal(w.size, 100, 'hard cap')
    for (let i = 0; i < 1000; i++) w.fail('hot')
    assert.equal(w.blockedFor('hot'), 1000)
    w.clear('hot')
    assert.equal(w.blockedFor('hot'), 0)
  })

  it('buckets client addresses: IPv4 as is, IPv6 by /64, junk as "unknown"', () => {
    assert.equal(ipBucket('203.0.113.7'), '203.0.113.7')
    assert.equal(ipBucket('::ffff:203.0.113.7'), '203.0.113.7')
    assert.equal(ipBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64')
    assert.equal(ipBucket('2001:DB8:0001:0002::9'), '2001:db8:1:2::/64')
    assert.equal(ipBucket('2001:db8::1'), '2001:db8:0:0::/64')
    assert.equal(ipBucket('x'.repeat(15_000)), 'unknown')
    assert.equal(ipBucket('1.2.3.4, 5.6.7.8'), 'unknown')
    assert.equal(ipBucket(undefined), 'unknown')
  })
})

describe('jsonEqual', () => {
  it('ignores key order and null/missing keys, but not values', () => {
    assert.equal(jsonEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }), true)
    assert.equal(jsonEqual({ a: 1, next: null }, { a: 1 }), true)
    assert.equal(jsonEqual({ a: 1, next: 's2' }, { a: 1 }), false)
    assert.equal(jsonEqual({ c: [1, 2] }, { c: [2, 1] }), false)
    assert.equal(jsonEqual({ c: [1] }, { c: { 0: 1 } }), false)
    assert.equal(jsonEqual({ m: '' }, { m: null }), false)
  })
})
