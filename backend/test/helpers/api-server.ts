/** Boots the real Express app on an ephemeral port with an in-memory database. */
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { AuthResponse } from '../../../shared/types.ts'
import { createApp } from '../../src/app.ts'
import { type Config, config as baseConfig } from '../../src/config.ts'
import { type DB, openDb } from '../../src/db/index.ts'
import { FakeEngine, FakeLinkedIn } from './api-fakes.ts'

export interface ApiResult<T = any> {
  status: number
  body: T
  headers: Headers
}

export interface CallOptions {
  token?: string
  body?: unknown
  headers?: Record<string, string>
  /** raw request body (sent as is, with JSON content type unless overridden) */
  raw?: string
}

export interface TestApi {
  url: string
  db: DB
  linkedin: FakeLinkedIn
  engine: FakeEngine
  config: Config
  call<T = any>(method: string, path: string, opts?: CallOptions): Promise<ApiResult<T>>
  /** Sign up a fresh user; returns token + user. */
  signup(opts?: { name?: string; email?: string; password?: string; inviteToken?: string }): Promise<AuthResponse>
  close(): Promise<void>
}

let seq = 0

export async function startApi(overrides: Partial<Config> = {}): Promise<TestApi> {
  const db = openDb(':memory:')
  const linkedin = new FakeLinkedIn()
  const engine = new FakeEngine()
  // trustProxy 1: tests send X-Forwarded-For as if one proxy (Render, Fly.io …) sat in front of the app
  const config: Config = { ...baseConfig, frontendDist: '/nonexistent-frontend-dist', publicAppUrl: '', corsOrigins: ['*'], trustProxy: 1, ...overrides }
  const app = createApp({ db, linkedin, engine, config })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  async function call<T = any>(method: string, path: string, opts: CallOptions = {}): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { ...opts.headers }
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`
    let payload: string | undefined
    if (opts.raw !== undefined) payload = opts.raw
    else if (opts.body !== undefined) payload = JSON.stringify(opts.body)
    if (payload !== undefined) headers['Content-Type'] ??= 'application/json'
    const res = await fetch(url + path, { method, headers, body: payload })
    const text = await res.text()
    let body: unknown = text
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      /* non-JSON (e.g. index.html) */
    }
    return { status: res.status, body: body as T, headers: res.headers }
  }

  async function signup(opts: { name?: string; email?: string; password?: string; inviteToken?: string } = {}) {
    const n = ++seq
    const res = await call<AuthResponse>('POST', '/api/auth/signup', {
      body: {
        name: opts.name ?? `User ${n}`,
        email: opts.email ?? `user${n}@example.com`,
        password: opts.password ?? 'correct horse battery',
        ...(opts.inviteToken ? { inviteToken: opts.inviteToken } : {}),
      },
    })
    if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`)
    return res.body
  }

  async function close() {
    server.closeAllConnections()
    server.close()
    await once(server, 'close').catch(() => {})
    db.close()
  }

  return { url, db, linkedin, engine, config, call, signup, close }
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

export const SETTINGS = {
  dailyInvites: 20,
  dailyMessages: 50,
  dailyProfileViews: 50,
  skipConnected: true,
  skipOtherCampaigns: true,
  stopOnReply: true,
}

/** invite (1–5 min) → message → condition(replied) yes:end / no:follow-up message */
export function sampleSequence() {
  return {
    rootId: 's1',
    steps: {
      s1: { id: 's1', kind: 'invite', delay: { min: 1, max: 5, unit: 'minutes' }, config: { message: 'Hi {{first_name}}' }, next: 's2' },
      s2: { id: 's2', kind: 'message', delay: { min: 1, max: 5, unit: 'minutes' }, config: { message: 'Thanks for connecting!' }, next: 's3' },
      s3: {
        id: 's3',
        kind: 'condition',
        delay: { min: 0, max: 0, unit: 'minutes' },
        config: { condition: 'replied', within: { value: 3, unit: 'days' } },
        yes: 's4',
        no: 's5',
      },
      s4: { id: 's4', kind: 'end', delay: { min: 0, max: 0, unit: 'minutes' }, config: {} },
      s5: { id: 's5', kind: 'message', delay: { min: 1, max: 5, unit: 'minutes' }, config: { message: 'Following up' }, next: null },
    },
  }
}

export const emptySeq = () => ({ rootId: null, steps: {} })

export const profile = (id: string) => `https://www.linkedin.com/in/${id}/`

export function campaignInput(over: Record<string, unknown> = {}) {
  return {
    name: 'Founders outreach',
    status: 'draft',
    sequence: sampleSequence(),
    settings: { ...SETTINGS },
    leads: [{ profileUrl: profile('ada-lovelace') }, { profileUrl: profile('alan-turing'), firstName: 'Alan', company: 'Bletchley' }],
    searchImports: [],
    ...over,
  }
}
