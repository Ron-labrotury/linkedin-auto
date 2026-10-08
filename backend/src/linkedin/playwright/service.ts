/**
 * Real LinkedIn through Playwright. One shared browser; one context per user, created from the
 * encrypted storageState, cached and closed after a period of inactivity. Pending sign-ins
 * (verification code / app approval) keep their page alive in memory until completed or expired.
 *
 * Memory: every context runs LinkedIn's heavy web app in its own renderer, so at most
 * MAX_BROWSER_CONTEXTS (default 3) contexts are open at once. When a new one is needed, the least
 * recently used idle context is closed (its session is in the database); engine work waits for a
 * free slot, sign-ins don't.
 */
import type { BrowserContext, Page } from 'playwright'
import { normalizeProfileUrl } from '../../../../shared/linkedin-url.ts'
import { isValidTimeZone } from '../../../../shared/time.ts'
import type { LinkedInProfile } from '../../../../shared/types.ts'
import type { Config } from '../../config.ts'
import { type DB, one } from '../../db/index.ts'
import { clearAccount, getAccount, loadSession, markExpired, readAccount, saveSession, updateAccount } from '../accounts.ts'
import { createKeyedMutex, errorMessage, isEnglishUi, NON_ENGLISH_MESSAGE, networkError, sleep } from '../common.ts'
import { type ConnectOutcome, LinkedInError, type LinkedInService } from '../types.ts'
import { createBrowserPool, isStorageState, type StorageState } from './browser.ts'
import { isAuthUrl, readTopCardInPage, uiLanguageInPage } from './dom.ts'
import { firstVisible, PlaywrightDriver } from './driver.ts'
import { HUMAN_PACING, type Pacing, pause, shortPause, typeLikeHuman } from './human.ts'
import { FEED_URL, LOGIN_URL, type LoginReading, PIN_INPUT, PIN_SUBMIT, readLoginState, TRANSIENT, waitForLogin } from './login.ts'

export interface PlaywrightServiceOptions {
  db: DB
  config: Config
  pacing?: Pacing
  /** close a user's browser context after this much inactivity (default 5 min) */
  idleMs?: number
  /** most browser contexts open at once (default: env MAX_BROWSER_CONTEXTS, else 3) */
  maxContexts?: number
  /** how long engine work waits for a free browser context before giving up as 'transient' (default 2 min) */
  capacityWaitMs?: number
  /** how long a sign-in waiting for a code / app approval is kept (default 10 min) */
  pendingTtlMs?: number
  /** how long to wait for LinkedIn to answer a sign-in step (default 30 s) */
  loginTimeoutMs?: number
  /** how long "Check" waits for the app approval to land (default 5 s) */
  checkWaitMs?: number
  setupContext?: (ctx: BrowserContext) => Promise<void> | void
}

interface Tab {
  context: BrowserContext
  page: Page
}

interface Session extends Tab {
  timer: ReturnType<typeof setTimeout> | null
  /** in use by withDriver / test / a sign-in: never closed to make room */
  busy: boolean
  lastUsed: number
}

interface PendingLogin extends Tab {
  kind: 'code' | 'app'
  email: string
  timer: ReturnType<typeof setTimeout>
}

const MSG = {
  wrong: 'Wrong email or password',
  captcha:
    "LinkedIn showed a security check (captcha) that can't be completed automatically. Sign in to linkedin.com in your browser and connect with your li_at cookie instead.",
  restricted: 'LinkedIn has restricted this account. Sign in at linkedin.com to resolve it, then connect again.',
  challenge:
    "LinkedIn asked for an extra security check that can't be completed here. Sign in at linkedin.com in your browser, then connect with your li_at cookie.",
  timeout: "LinkedIn didn't respond in time. Please try again, or connect with your li_at cookie.",
  relogin: 'LinkedIn asked to sign in again. Please start over.',
  app: 'LinkedIn sent a sign-in request to your LinkedIn mobile app. Open the app, tap "Yes" to approve it, then click "Check".',
  appWaiting: 'Still waiting for you to approve the sign-in in the LinkedIn app.',
  code: 'LinkedIn sent you a verification code (by email or SMS, or use your authenticator app). Enter it here to finish connecting.',
  badCode: "That code didn't work. Check the code and try again.",
  cookie: 'That cookie is invalid or expired',
  cookieChallenge: 'LinkedIn wants to verify this sign-in. Sign in at linkedin.com in your browser first, then copy a fresh li_at cookie.',
  timedOut: 'Verification timed out. Please sign in again.',
  interrupted: 'The sign-in was interrupted. Please sign in again.',
  signedOut: 'LinkedIn signed this account out. Please reconnect your LinkedIn account.',
  verify: 'LinkedIn asked for a security verification. Please reconnect your LinkedIn account.',
}

/** First line of an error, with any secret (password, cookie) blanked out. */
const short = (e: unknown, ...secrets: string[]) => {
  let msg = errorMessage(e).split('\n')[0]
  for (const secret of secrets) if (secret) msg = msg.split(secret).join('***')
  return msg.slice(0, 200)
}

export interface PlaywrightService extends LinkedInService {
  /** browser contexts currently open (sessions, pending sign-ins, sign-ins in progress) */
  readonly openContexts: number
}

/** MAX_BROWSER_CONTEXTS from the environment (at least 1), default 3. */
export function maxContextsFromEnv(env: Record<string, string | undefined> = process.env) {
  const n = Math.floor(Number(env.MAX_BROWSER_CONTEXTS))
  return Number.isFinite(n) && n >= 1 ? n : 3
}

export function createPlaywrightService(opts: PlaywrightServiceOptions): PlaywrightService {
  const { db, config } = opts
  const pacing = opts.pacing ?? HUMAN_PACING
  const idleMs = opts.idleMs ?? 5 * 60_000
  const maxContexts = Math.max(1, opts.maxContexts ?? maxContextsFromEnv())
  const capacityWaitMs = opts.capacityWaitMs ?? 2 * 60_000
  const pendingTtlMs = opts.pendingTtlMs ?? 10 * 60_000
  const loginTimeoutMs = opts.loginTimeoutMs ?? 30_000
  const checkWaitMs = opts.checkWaitMs ?? 5_000
  const pool = createBrowserPool({ headless: config.headless, setupContext: opts.setupContext })
  const withLock = createKeyedMutex()
  const sessions = new Map<string, Session>()
  const pending = new Map<string, PendingLogin>()
  /** every context this service opened and has not closed */
  const live = new Set<BrowserContext>()
  /** contexts being created right now (counted against the cap) */
  let reserved = 0
  let wakeups: (() => void)[] = []
  let closing = false

  /* ------------------------------ contexts ------------------------------ */

  function timezoneOf(userId: string) {
    const row = one<{ timezone: string }>(db, 'SELECT timezone FROM user_settings WHERE user_id = ?', userId)
    return row && isValidTimeZone(row.timezone) ? row.timezone : undefined
  }

  function wake() {
    const w = wakeups
    wakeups = []
    for (const f of w) f()
  }

  async function closeContext(context: BrowserContext) {
    if (live.delete(context)) wake()
    await context.close().catch(() => {})
  }

  /** Close the least recently used session that nobody is using; null when there is none. */
  function evictIdle(): Promise<void> | null {
    let victim: [string, Session] | null = null
    for (const entry of sessions) if (!entry[1].busy && (!victim || entry[1].lastUsed < victim[1].lastUsed)) victim = entry
    if (!victim) return null
    const [userId, s] = victim
    sessions.delete(userId)
    if (s.timer) clearTimeout(s.timer)
    return closeContext(s.context)
  }

  /**
   * A slot for one more browser context: closes idle sessions (least recently used first) while the
   * cap is reached. With `wait`, waits for a busy session to become idle (up to capacityWaitMs);
   * without, goes over the cap rather than keep a person waiting on a sign-in.
   */
  async function acquireSlot(wait: boolean): Promise<() => void> {
    const deadline = Date.now() + capacityWaitMs
    for (;;) {
      if (closing) throw new LinkedInError('transient', 'The server is shutting down')
      while (live.size + reserved >= maxContexts) {
        const evicted = evictIdle()
        if (!evicted) break
        await evicted
      }
      if (live.size + reserved < maxContexts || !wait) {
        reserved++
        let released = false
        return () => {
          if (released) return
          released = true
          reserved--
          wake()
        }
      }
      if (Date.now() >= deadline) {
        throw new LinkedInError('transient', `The server is busy: ${maxContexts} LinkedIn browser sessions are already open (MAX_BROWSER_CONTEXTS). Trying again later.`)
      }
      await new Promise<void>((resolve) => {
        wakeups.push(resolve)
        setTimeout(resolve, 500).unref?.()
      })
    }
  }

  async function openTab(userId: string, state: StorageState | null, wait = false): Promise<Tab> {
    const release = await acquireSlot(wait)
    try {
      const context = await pool.newContext(state, timezoneOf(userId))
      live.add(context)
      context.on('close', () => {
        if (live.delete(context)) wake()
      })
      try {
        const page = await context.newPage()
        // Accept "leave page?" prompts (unsent drafts) so navigation never hangs; dismiss the rest.
        page.on('dialog', (d) => void (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {}))
        page.setDefaultTimeout(pacing.elementTimeoutMs)
        page.setDefaultNavigationTimeout(pacing.navTimeoutMs)
        return { context, page }
      } catch (e) {
        await closeContext(context)
        throw e
      }
    } finally {
      release()
    }
  }

  async function closeSession(userId: string) {
    const s = sessions.get(userId)
    if (!s) return
    sessions.delete(userId)
    if (s.timer) clearTimeout(s.timer)
    await closeContext(s.context)
  }

  async function closePending(userId: string) {
    const p = pending.get(userId)
    if (!p) return
    pending.delete(userId)
    clearTimeout(p.timer)
    await closeContext(p.context)
  }

  function touch(userId: string, s: Session) {
    if (s.timer) clearTimeout(s.timer)
    s.timer = setTimeout(
      () => void withLock(userId, async () => (sessions.get(userId) === s && !s.busy ? closeSession(userId) : undefined)),
      idleMs,
    )
    s.timer.unref?.()
  }

  /** The session is free again (may be closed to make room). */
  function release(s: Session) {
    s.busy = false
    s.lastUsed = Date.now()
    wake()
  }

  async function persist(userId: string, s: Session) {
    try {
      saveSession(db, userId, await s.context.storageState())
    } catch {
      /* context already gone */
    }
  }

  /** The cached logged-in context, or a new one from the stored session; marked busy until release(). */
  async function sessionFor(userId: string, wait: boolean): Promise<Session> {
    let s = sessions.get(userId)
    if (s && s.page.isClosed()) {
      await closeSession(userId)
      s = sessions.get(userId)
    }
    if (s) s.busy = true
    else {
      const state = loadSession<unknown>(db, userId)
      if (!isStorageState(state)) {
        throw new LinkedInError('session_expired', state === null ? 'Connect your LinkedIn account first.' : 'Your saved LinkedIn session is not valid. Please reconnect.')
      }
      s = { ...(await openTab(userId, state, wait)), timer: null, busy: true, lastUsed: Date.now() }
      sessions.set(userId, s)
    }
    touch(userId, s)
    return s
  }

  /** NON_ENGLISH_MESSAGE when the logged-in page is shown in another language, else null. */
  async function languageProblem(page: Page): Promise<string | null> {
    const lang = await page.evaluate(uiLanguageInPage).catch(() => '')
    return isEnglishUi(lang) ? null : NON_ENGLISH_MESSAGE
  }

  /* ------------------------------ accounts ------------------------------ */

  function fail(userId: string, message: string, patch: { authMethod?: 'password' | 'cookie'; email?: string | null } = {}): ConnectOutcome {
    return { account: updateAccount(db, userId, { status: 'error', lastError: message, ...patch }), message }
  }

  function nothingPending(userId: string): ConnectOutcome {
    const account = getAccount(db, userId)
    if (account.status === 'needs_verification' || account.status === 'needs_app_approval') return fail(userId, MSG.interrupted)
    if (account.status === 'connected') return { account, message: 'Your LinkedIn account is already connected.' }
    return { account, message: 'There is no sign-in waiting for verification. Please sign in again.' }
  }

  async function fetchOwnProfile(page: Page): Promise<LinkedInProfile | null> {
    try {
      // /in/me/ redirects to the member's own profile; a redirect can abort goto, so keep polling.
      await page.goto('https://www.linkedin.com/in/me/', { waitUntil: 'domcontentloaded' }).catch(() => {})
      const deadline = Date.now() + pacing.elementTimeoutMs
      let card = await page.evaluate(readTopCardInPage).catch(() => null)
      while (!card?.found || !card.name || !/linkedin\.com\/in\//i.test(card.url)) {
        if (Date.now() > deadline || isAuthUrl(page.url())) return null
        await sleep(400)
        card = await page.evaluate(readTopCardInPage).catch(() => null)
      }
      const navPhoto = await page
        .evaluate(() => (document.querySelector('img.global-nav__me-photo') as HTMLImageElement | null)?.src ?? null)
        .catch(() => null)
      const url = normalizeProfileUrl(card.url)
      return {
        name: card.name,
        headline: card.headline,
        profileUrl: url && !url.endsWith('/in/me/') ? url : '',
        imageUrl: card.imageUrl ?? (navPhoto && /^https?:/i.test(navPhoto) ? navPhoto : null),
      }
    } catch {
      return null
    }
  }

  /** The tab is logged in: make it the user's session, save it and the profile. */
  async function finishConnected(userId: string, tab: Tab, method: 'password' | 'cookie', email: string | null): Promise<ConnectOutcome> {
    const p = pending.get(userId)
    if (p && p.context === tab.context) {
      clearTimeout(p.timer)
      pending.delete(userId)
    }
    if (sessions.get(userId)?.context !== tab.context) await closeSession(userId)
    const s: Session = { ...tab, timer: null, busy: true, lastUsed: Date.now() }
    sessions.set(userId, s)
    touch(userId, s)
    try {
      const prev = readAccount(db, userId)
      // LinkedIn's interface language is the member's setting: read it on the page we landed on.
      const langProblem = await languageProblem(tab.page)
      // A placeholder profile has no profileUrl, so it is never used to tell our messages apart.
      // The previous profile is only kept for the same email (cookie sign-ins have none to compare).
      const profile: LinkedInProfile = (await fetchOwnProfile(tab.page)) ??
        (prev.profile && email !== null && prev.email === email ? prev.profile : { name: email ?? 'LinkedIn account', headline: '', profileUrl: '', imageUrl: null })
      const account = updateAccount(db, userId, {
        // Saved anyway: once LinkedIn is switched to English, "Test" makes the account usable.
        status: langProblem ? 'error' : 'connected',
        authMethod: method,
        email,
        profile,
        session: await tab.context.storageState(),
        lastError: langProblem,
        lastCheckedAt: Date.now(),
      })
      return { account, message: langProblem ?? `Connected as ${profile.name}.` }
    } finally {
      release(s)
    }
  }

  function keepPending(userId: string, tab: Tab, kind: 'code' | 'app', email: string) {
    const existing = pending.get(userId)
    if (existing && existing.context === tab.context) {
      existing.kind = kind
      return
    }
    const entry: PendingLogin = {
      ...tab,
      kind,
      email,
      timer: setTimeout(
        () =>
          void withLock(userId, async () => {
            if (pending.get(userId) !== entry) return
            await closePending(userId)
            const status = readAccount(db, userId).status
            if (status === 'needs_verification' || status === 'needs_app_approval') updateAccount(db, userId, { status: 'error', lastError: MSG.timedOut })
          }),
        pendingTtlMs,
      ),
    }
    entry.timer.unref?.()
    pending.set(userId, entry)
  }

  async function skipInterstitial(page: Page): Promise<LoginReading> {
    const skip = await firstVisible([page.getByRole('button', { name: /^(skip|not now|remind me later|no,? thanks)$/i })], 1500)
    if (skip) await skip.click().catch(() => {})
    let r = await waitForLogin(page, 5000, (x) => x.state !== 'unknown' && x.state !== 'interstitial')
    if (r.state === 'interstitial' || r.state === 'unknown') {
      await page.goto(FEED_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
      r = await waitForLogin(page, loginTimeoutMs, (x) => x.state !== 'unknown' && x.state !== 'interstitial')
    }
    return r
  }

  function loginErrorText(r: LoginReading) {
    const s = r.snapshot
    return s ? s.passwordError || s.usernameError || s.formError : ''
  }

  /** Act on where a password sign-in landed. Takes ownership of `tab` (kept, or closed on failure). */
  async function resolveLogin(userId: string, tab: Tab, reading: LoginReading, email: string): Promise<ConnectOutcome> {
    let r = reading
    if (r.state === 'interstitial') r = await skipInterstitial(tab.page)
    if (r.state === 'logged_in') return finishConnected(userId, tab, 'password', email)
    if (r.state === 'pin' || r.state === 'app_approval') {
      const kind = r.state === 'pin' ? 'code' : 'app'
      keepPending(userId, tab, kind, email)
      const account = updateAccount(db, userId, {
        status: kind === 'code' ? 'needs_verification' : 'needs_app_approval',
        authMethod: 'password',
        email,
        lastError: null,
      })
      const hint = r.snapshot?.description ?? ''
      const message = kind === 'app' ? MSG.app : /code/i.test(hint) ? `LinkedIn: "${hint}" Enter the code here to finish connecting.` : MSG.code
      return { account, message }
    }
    if (pending.get(userId)?.context === tab.context) await closePending(userId)
    else await tab.context.close().catch(() => {})
    const message =
      r.state === 'captcha'
        ? MSG.captcha
        : r.state === 'wrong_credentials'
          ? MSG.wrong
          : r.state === 'login_error'
            ? `LinkedIn: ${loginErrorText(r)}`
            : r.state === 'restricted'
              ? MSG.restricted
              : r.state === 'challenge'
                ? MSG.challenge
                : r.state === 'login_form'
                  ? MSG.relogin
                  : MSG.timeout
    return fail(userId, message, { authMethod: 'password', email })
  }

  async function acceptCookieBanner(page: Page) {
    const accept = await firstVisible([page.getByRole('button', { name: /^accept( all)?( cookies)?$/i })], 300)
    if (accept) await accept.click().catch(() => {})
  }

  /** Ready when the page shows a definite state, or ended up on a login/authwall URL. */
  const settled = (r: LoginReading) => !TRANSIENT.includes(r.state) || (!!r.snapshot && isAuthUrl(r.snapshot.url))

  /* ------------------------------ service ------------------------------- */

  return {
    kind: 'playwright',

    getAccount(userId) {
      const account = getAccount(db, userId)
      if ((account.status === 'needs_verification' || account.status === 'needs_app_approval') && !pending.has(userId)) {
        return updateAccount(db, userId, { status: 'error', lastError: MSG.interrupted })
      }
      return account
    },

    loginWithPassword(userId, rawEmail, password) {
      return withLock(userId, async () => {
        const email = rawEmail.trim()
        if (!email || !password) return fail(userId, 'Enter your LinkedIn email and password.')
        await closePending(userId)
        let tab: Tab | null = null
        try {
          tab = await openTab(userId, null)
          const page = tab.page
          await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' })
          const user = page.locator('#username, input[name="session_key"]').first()
          await user.waitFor({ state: 'visible', timeout: pacing.elementTimeoutMs })
          await acceptCookieBanner(page)
          await pause(pacing)
          await user.click()
          await typeLikeHuman(page, email, pacing)
          await shortPause(pacing)
          const pass = page.locator('#password, input[name="session_password"]').first()
          await pass.click()
          // Typing a tab would move the focus: such passwords are filled as-is.
          if (password.includes('\t')) await pass.fill(password)
          else await typeLikeHuman(page, password, pacing)
          await shortPause(pacing)
          const submit = await firstVisible(
            [
              page.locator('form').filter({ has: pass }).locator('button[type="submit"]'),
              page.getByRole('button', { name: /^sign in$/i }),
              page.locator('button[type="submit"]'),
            ],
            2000,
          )
          if (submit) await submit.click()
          else await pass.press('Enter')
          const reading = await waitForLogin(page, loginTimeoutMs)
          const owned = tab
          tab = null
          // Still on the plain form after the timeout: LinkedIn never answered the submit.
          return await resolveLogin(userId, owned, reading.state === 'login_form' ? { ...reading, state: 'unknown' } : reading, email)
        } catch (e) {
          return fail(userId, networkError(e) ?? `Could not sign in to LinkedIn: ${short(e, password)}`, { authMethod: 'password', email })
        } finally {
          if (tab) await tab.context.close().catch(() => {})
        }
      })
    },

    submitVerificationCode(userId, rawCode) {
      return withLock(userId, async () => {
        const p = pending.get(userId)
        if (!p) return nothingPending(userId)
        const code = rawCode.replace(/[\s-]+/g, '')
        if (!/^\d{4,10}$/.test(code)) return { account: getAccount(db, userId), message: 'Enter the numeric code LinkedIn sent you.' }
        try {
          const page = p.page
          let r = await readLoginState(page)
          if (r.state !== 'pin') {
            if (r.state === 'app_approval') return { account: getAccount(db, userId), message: MSG.appWaiting }
            return await resolveLogin(userId, p, r, p.email)
          }
          const prevError = r.snapshot?.formError ?? ''
          const input = page.locator(PIN_INPUT).filter({ visible: true }).first()
          await input.click()
          await input.fill('')
          await typeLikeHuman(page, code, pacing)
          await shortPause(pacing)
          let navigated = false
          const onNav = (f: unknown) => {
            if (f === page.mainFrame()) navigated = true
          }
          page.on('framenavigated', onNav)
          try {
            const submit = await firstVisible([page.locator(PIN_SUBMIT), page.getByRole('button', { name: /^(submit|verify|continue|confirm)$/i })], 2000)
            if (submit) await submit.click()
            else await input.press('Enter')
            r = await waitForLogin(
              page,
              loginTimeoutMs,
              (x) => !TRANSIENT.includes(x.state) && (x.state !== 'pin' || (!!x.snapshot?.formError && (navigated || x.snapshot.formError !== prevError))),
            )
          } finally {
            page.off('framenavigated', onNav)
          }
          if (r.state === 'pin' || r.state === 'unknown') {
            if (r.snapshot?.formError) return { account: updateAccount(db, userId, { lastError: MSG.badCode }), message: MSG.badCode }
            return { account: getAccount(db, userId), message: "LinkedIn hasn't accepted the code yet. Check it and try again." }
          }
          return await resolveLogin(userId, p, r, p.email)
        } catch (e) {
          await closePending(userId)
          return fail(userId, `Verification failed: ${short(e)}`)
        }
      })
    },

    checkPendingLogin(userId) {
      return withLock(userId, async () => {
        const p = pending.get(userId)
        if (!p) return nothingPending(userId)
        try {
          const r = await waitForLogin(p.page, checkWaitMs, (x) => !TRANSIENT.includes(x.state) && x.state !== 'app_approval')
          if (r.state === 'app_approval' || TRANSIENT.includes(r.state)) return { account: getAccount(db, userId), message: MSG.appWaiting }
          if (r.state === 'pin' && p.kind === 'code') return { account: getAccount(db, userId), message: MSG.code }
          return await resolveLogin(userId, p, r, p.email)
        } catch (e) {
          await closePending(userId)
          return fail(userId, `Sign-in failed: ${short(e)}`)
        }
      })
    },

    connectWithCookie(userId, liAt) {
      return withLock(userId, async () => {
        const value = liAt
          .trim()
          .replace(/^li_at\s*=\s*/i, '')
          .replace(/;.*$/, '')
          .replace(/^"|"$/g, '')
          .trim()
        if (value.length < 10 || /[\s,;"]/.test(value)) return fail(userId, MSG.cookie, { authMethod: 'cookie' })
        await closePending(userId)
        let tab: Tab | null = null
        try {
          tab = await openTab(userId, null)
          await tab.context.addCookies([
            {
              name: 'li_at',
              value,
              domain: '.linkedin.com',
              path: '/',
              secure: true,
              httpOnly: true,
              sameSite: 'None',
              expires: Math.floor(Date.now() / 1000) + 365 * 86_400,
            },
          ])
          const offline = await tab.page.goto(FEED_URL, { waitUntil: 'domcontentloaded' }).then(() => null, networkError)
          if (offline) return fail(userId, offline, { authMethod: 'cookie' })
          let r = await waitForLogin(tab.page, loginTimeoutMs, settled)
          if (r.state === 'interstitial') r = await skipInterstitial(tab.page)
          if (r.state === 'logged_in') {
            const owned = tab
            tab = null
            return await finishConnected(userId, owned, 'cookie', null)
          }
          const checkpoint = ['pin', 'app_approval', 'captcha', 'challenge', 'restricted'].includes(r.state)
          if (r.state === 'unknown' && !(r.snapshot && isAuthUrl(r.snapshot.url))) return fail(userId, MSG.timeout, { authMethod: 'cookie' })
          return fail(userId, checkpoint ? MSG.cookieChallenge : MSG.cookie, { authMethod: 'cookie' })
        } catch (e) {
          return fail(userId, networkError(e) ?? `Could not open LinkedIn: ${short(e, value)}`, { authMethod: 'cookie' })
        } finally {
          if (tab) await tab.context.close().catch(() => {})
        }
      })
    },

    test(userId) {
      return withLock(userId, async () => {
        const account = getAccount(db, userId)
        if (account.status === 'needs_verification' || account.status === 'needs_app_approval') {
          return { ok: false, message: 'Finish signing in to LinkedIn first.', account }
        }
        let s: Session
        try {
          s = await sessionFor(userId, false)
        } catch (e) {
          if (!(e instanceof LinkedInError)) {
            return { ok: false, message: `Could not start the browser: ${short(e)}`, account }
          }
          if (e.code !== 'session_expired') return { ok: false, message: e.message, account }
          if (account.status === 'connected') markExpired(db, userId, e.message)
          const now = getAccount(db, userId)
          const message = now.status === 'expired' ? 'Your LinkedIn session has expired. Please reconnect your account.' : 'Connect your LinkedIn account first.'
          return { ok: false, message, account: now }
        }
        try {
          const offline = await s.page.goto(FEED_URL, { waitUntil: 'domcontentloaded' }).then(() => null, networkError)
          if (offline) return { ok: false, message: offline, account: updateAccount(db, userId, { lastCheckedAt: Date.now(), lastError: offline }) }
          let r = await waitForLogin(s.page, loginTimeoutMs, settled)
          if (r.state === 'interstitial') r = await skipInterstitial(s.page)
          if (r.state === 'logged_in') {
            const langProblem = await languageProblem(s.page)
            const profile = (await fetchOwnProfile(s.page)) ?? account.profile
            await persist(userId, s)
            if (langProblem) {
              return { ok: false, message: langProblem, account: updateAccount(db, userId, { status: 'error', profile, lastCheckedAt: Date.now(), lastError: langProblem }) }
            }
            const updated = updateAccount(db, userId, { status: 'connected', profile, lastCheckedAt: Date.now(), lastError: null })
            return { ok: true, message: `Connected as ${profile?.name ?? 'your LinkedIn account'}. LinkedIn is reachable and the session works.`, account: updated }
          }
          if (r.state === 'unknown' && !(r.snapshot && isAuthUrl(r.snapshot.url))) {
            const message = "Couldn't reach LinkedIn. Check the server's internet connection and try again."
            return { ok: false, message, account: updateAccount(db, userId, { lastCheckedAt: Date.now(), lastError: message }) }
          }
          const message = ['pin', 'app_approval', 'captcha', 'challenge', 'restricted'].includes(r.state) ? MSG.verify : MSG.signedOut
          await closeSession(userId)
          return { ok: false, message, account: updateAccount(db, userId, { status: 'expired', lastError: message, lastCheckedAt: Date.now() }) }
        } catch (e) {
          const message = networkError(e) ?? `Couldn't reach LinkedIn: ${short(e)}`
          return { ok: false, message, account: updateAccount(db, userId, { lastCheckedAt: Date.now(), lastError: message }) }
        } finally {
          release(s)
        }
      })
    },

    disconnect(userId) {
      return withLock(userId, async () => {
        await closePending(userId)
        await closeSession(userId)
        clearAccount(db, userId)
      })
    },

    withDriver(userId, fn) {
      return withLock(userId, async () => {
        const account = getAccount(db, userId)
        if (account.status !== 'connected') {
          throw new LinkedInError(
            'session_expired',
            account.status === 'expired' ? (account.lastError ?? MSG.signedOut) : 'Connect your LinkedIn account first.',
          )
        }
        let s: Session
        try {
          s = await sessionFor(userId, true)
        } catch (e) {
          if (e instanceof LinkedInError) {
            if (e.code === 'session_expired') markExpired(db, userId, e.message)
            throw e
          }
          // The browser failed to start: a server problem, not the lead's or the account's.
          throw new LinkedInError('transient', `Could not start the browser: ${short(e)}`)
        }
        // Our own name tells our messages apart only when it was read from our profile.
        const own = account.profile?.profileUrl ? account.profile : null
        const driver = new PlaywrightDriver(s.page, { pacing, ownName: own?.name ?? null, ownProfileUrl: own?.profileUrl ?? null, isClosing: () => closing })
        try {
          return await fn(driver)
        } catch (e) {
          if (e instanceof LinkedInError && e.code === 'session_expired') {
            markExpired(db, userId, e.message)
            await closeSession(userId)
          }
          // E.g. LinkedIn's interface is not English: nothing can run until the user fixes it and tests again.
          if (e instanceof LinkedInError && e.code === 'account_problem') updateAccount(db, userId, { status: 'error', lastError: e.message })
          throw e
        } finally {
          if (sessions.get(userId) === s) {
            await persist(userId, s)
            touch(userId, s)
          }
          release(s)
        }
      })
    },

    get openContexts() {
      return live.size
    },

    async shutdown() {
      // From now on no new irreversible action starts (the driver checks isClosing before clicking).
      closing = true
      wake()
      const users = new Set([...sessions.keys(), ...pending.keys()])
      const graceful = Promise.all(
        [...users].map((userId) =>
          withLock(userId, async () => {
            const s = sessions.get(userId)
            if (s) await persist(userId, s)
            await closeSession(userId)
            await closePending(userId)
          }),
        ),
      )
      // Give an action in flight time to confirm what it already clicked (a message being
      // verified), but don't wait forever: closing the browser ends it.
      await Promise.race([graceful, sleep(Math.max(10_000, pacing.verifyTimeoutMs + 8_000))])
      for (const s of sessions.values()) if (s.timer) clearTimeout(s.timer)
      for (const p of pending.values()) clearTimeout(p.timer)
      await pool.close()
    },
  }
}
