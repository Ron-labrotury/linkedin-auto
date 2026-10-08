/**
 * Real headless Chromium for the LinkedIn DOM tests. Fixtures (test/fixtures/*.html) are either
 * loaded with page.setContent, or served at https://www.linkedin.com/... through request routing,
 * so the code under test navigates exactly as it would on LinkedIn — without any network.
 */
import fs from 'node:fs'
import path from 'node:path'
import { type Browser, type BrowserContext, chromium, type Page, type Request } from 'playwright'
import type { Pacing } from '../../src/linkedin/playwright/human.ts'

export const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures')

export const fixture = (name: string, vars: Record<string, string> = {}) => {
  let html = fs.readFileSync(path.join(FIXTURES, name), 'utf8')
  for (const [k, v] of Object.entries(vars)) html = html.split(`{{${k}}}`).join(v)
  return html
}

/** Instant pacing and short timeouts for tests. */
export const FAST: Pacing = {
  pauseMs: [0, 5],
  shortPauseMs: [0, 5],
  keyDelayMs: [0, 1],
  navTimeoutMs: 10_000,
  elementTimeoutMs: 3_000,
  verifyTimeoutMs: 3_000,
  historySettleMs: 1_000,
  scroll: false,
}

let browser: Browser | null = null

export async function getBrowser() {
  browser ??= await chromium.launch({ headless: true })
  return browser
}

export async function closeBrowser() {
  await browser?.close()
  browser = null
}

/** A fresh page with the given HTML loaded (scripts run). */
export async function pageWith(html: string): Promise<Page> {
  const ctx = await (await getBrowser()).newContext({ viewport: { width: 1366, height: 768 }, locale: 'en-US' })
  const page = await ctx.newPage()
  await page.setContent(html)
  return page
}

export interface Reply {
  status?: number
  body?: string
  /** redirect target (absolute or path) */
  location?: string
  headers?: Record<string, string>
  contentType?: string
}

export type Handler = (url: URL, req: Request) => Reply | string | Promise<Reply | string>

/** Serve linkedin.com (and media.licdn.com) from `handler`; anything else is aborted. */
export async function routeLinkedIn(ctx: BrowserContext, handler: Handler) {
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (url.hostname === 'media.licdn.com') return route.fulfill({ status: 200, contentType: 'image/png', body: '' })
    if (!/(^|\.)linkedin\.com$/.test(url.hostname)) return route.abort()
    const out = await handler(url, req)
    const r: Reply = typeof out === 'string' ? { body: out } : out
    if (r.location) {
      // Fulfilled 3xx responses escape routing in this sandbox, so redirects are emulated client-side
      // (right after DOMContentLoaded, keeping any Set-Cookie header).
      const to = JSON.stringify(new URL(r.location, url).toString())
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        headers: r.headers,
        body: `<!doctype html><html><head><title>Redirecting</title></head><body><script>addEventListener('DOMContentLoaded', () => setTimeout(() => location.replace(${to}), 0))</script></body></html>`,
      })
    }
    return route.fulfill({ status: r.status ?? 200, contentType: r.contentType ?? 'text/html; charset=utf-8', headers: r.headers, body: r.body ?? '' })
  })
}

/** A page whose linkedin.com requests are answered by `handler`. */
export async function linkedInPage(handler: Handler): Promise<Page> {
  const ctx = await (await getBrowser()).newContext({ viewport: { width: 1366, height: 768 }, locale: 'en-US' })
  await routeLinkedIn(ctx, handler)
  const page = await ctx.newPage()
  page.on('dialog', (d) => void d.accept().catch(() => {}))
  return page
}

export const closePage = (page: Page) => page.context().close()

/** Parse an application/x-www-form-urlencoded POST body. */
export const form = (req: Request) => Object.fromEntries(new URLSearchParams(req.postData() ?? ''))

export async function cookieOf(req: Request, name: string) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec((await req.allHeaders())['cookie'] ?? '')
  return m ? m[1] : null
}
