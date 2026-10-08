/** One shared Chromium for every user; each user gets their own BrowserContext (cookies). */
import type { Browser, BrowserContext } from 'playwright'
import { errorMessage } from '../common.ts'

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>

export const isStorageState = (s: unknown): s is StorageState => !!s && typeof s === 'object' && Array.isArray((s as { cookies?: unknown }).cookies)

export interface BrowserPoolOptions {
  headless: boolean
  /** Runs for every new context (tests use it to serve fixtures for linkedin.com). */
  setupContext?: (ctx: BrowserContext) => Promise<void> | void
}

/** A realistic desktop Chrome user agent matching the bundled Chromium version and the host OS. */
export function userAgentFor(browserVersion: string, platform: string = process.platform) {
  const major = browserVersion.split('.')[0] || '141'
  const os =
    platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

export function createBrowserPool(opts: BrowserPoolOptions) {
  let browser: Promise<Browser> | null = null

  async function launch(): Promise<Browser> {
    const { chromium } = await import('playwright')
    // /dev/shm is tiny in most containers (64 MB in Docker): let Chromium use /tmp instead of crashing.
    const args = ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage']
    let b: Browser
    try {
      // "new headless" (full Chromium) looks like regular Chrome; fall back to the headless shell.
      b = await chromium.launch(opts.headless ? { headless: true, channel: 'chromium', args } : { headless: false, args })
    } catch (first) {
      try {
        b = await chromium.launch({ headless: opts.headless, args })
      } catch {
        throw new Error(`Could not start Chromium (${errorMessage(first).split('\n')[0]}). Install it with "npx playwright install chromium".`)
      }
    }
    return b
  }

  function getBrowser() {
    if (!browser) {
      const p = launch()
      browser = p
      p.then(
        (b) => b.on('disconnected', () => browser === p && (browser = null)),
        () => browser === p && (browser = null),
      )
    }
    return browser
  }

  async function newContext(storageState: StorageState | null, timezoneId?: string): Promise<BrowserContext> {
    const b = await getBrowser()
    const base = {
      storageState: storageState ?? undefined,
      userAgent: userAgentFor(b.version()),
      viewport: { width: 1366, height: 768 },
      screen: { width: 1366, height: 768 },
      locale: 'en-US',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    }
    let ctx: BrowserContext
    try {
      ctx = await b.newContext({ ...base, timezoneId })
    } catch (e) {
      if (!timezoneId) throw e
      ctx = await b.newContext(base)
    }
    if (opts.setupContext) await opts.setupContext(ctx)
    return ctx
  }

  async function close() {
    const p = browser
    browser = null
    const b = p ? await p.catch(() => null) : null
    await b?.close().catch(() => {})
  }

  return { newContext, close }
}

export type BrowserPool = ReturnType<typeof createBrowserPool>
