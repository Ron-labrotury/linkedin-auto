import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const env = process.env

const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()))
const num = (v: string | undefined, d: number) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v))

const isProd = env.NODE_ENV === 'production'
const DEV_SECRET = 'dev-only-secret-change-me-dev-only-secret'

export const config = {
  isProd,
  port: num(env.PORT, 8787),
  /** Directory for the SQLite database (mount a persistent volume here in production). */
  dataDir: path.resolve(env.DATA_DIR ?? path.join(here, '..', 'data')),
  /** Encrypts stored LinkedIn sessions. Changing it invalidates every stored session. */
  appSecret: env.APP_SECRET ?? DEV_SECRET,
  usingDevSecret: !env.APP_SECRET,
  /** Comma-separated allowed origins, or "*" (default). */
  corsOrigins: (env.CORS_ORIGIN ?? '*').split(',').map((s) => s.trim()).filter(Boolean),
  /** "playwright" drives a real browser; "simulated" fakes LinkedIn for local testing. */
  linkedinDriver: (env.LINKEDIN_DRIVER === 'simulated' ? 'simulated' : 'playwright') as 'playwright' | 'simulated',
  headless: bool(env.HEADLESS, true),
  engineEnabled: bool(env.ENGINE_ENABLED, true),
  engineTickMs: num(env.ENGINE_TICK_MS, 15_000),
  /** Built frontend to serve from the same origin (optional). */
  frontendDist: path.resolve(env.FRONTEND_DIST ?? path.join(here, '..', '..', 'frontend', 'dist')),
  /** Public URL of the frontend, used to build team invite links. Empty = app-relative links. */
  publicAppUrl: (env.PUBLIC_APP_URL ?? '').replace(/\/$/, ''),
  sessionTtlMs: num(env.SESSION_TTL_DAYS, 30) * 86_400_000,
  /**
   * Express "trust proxy": how many reverse proxies sit in front of the app (Render, Railway and
   * Fly.io each add one). Used to read the client IP for the login rate limit. "false" when the
   * app is exposed directly; a comma-separated list of proxy IPs/subnets also works.
   */
  trustProxy: ((v: string | undefined): boolean | number | string => {
    if (v === undefined || v === '') return 1
    if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true'
    return /^\d+$/.test(v) ? Number(v) : v
  })(env.TRUST_PROXY),
  /** Simulated driver tuning (LINKEDIN_DRIVER=simulated only). */
  sim: {
    acceptAfterMs: num(env.SIM_ACCEPT_AFTER_MS, 2 * 60_000),
    replyAfterMs: num(env.SIM_REPLY_AFTER_MS, 3 * 60_000),
    actionLatencyMs: num(env.SIM_ACTION_LATENCY_MS, 300),
  },
}

export type Config = typeof config

if (config.isProd && config.usingDevSecret) {
  throw new Error('APP_SECRET must be set in production (any long random string).')
}
