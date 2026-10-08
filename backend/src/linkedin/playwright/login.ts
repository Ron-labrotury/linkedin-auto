/** Detecting where a LinkedIn sign-in ended up (feed, PIN challenge, app approval, captcha, error…). */
import type { Page } from 'playwright'
import { sleep } from '../common.ts'

export const LOGIN_URL = 'https://www.linkedin.com/login'
export const FEED_URL = 'https://www.linkedin.com/feed/'
export const PIN_INPUT = [
  'input[name="pin"]',
  '#input__email_verification_pin',
  '#input__phone_verification_pin',
  'input[autocomplete="one-time-code"]',
  'input[name="verificationCode"]',
].join(', ')
export const PIN_SUBMIT = '#email-pin-submit-button, #two-step-submit-button, #pin-submit-button, form button[type="submit"]'

export interface LoginSnapshot {
  url: string
  loggedIn: boolean
  /** the page has rendered a main region (not a blank/redirecting document) */
  hasMain: boolean
  loginForm: boolean
  pinInput: boolean
  appApproval: boolean
  captcha: boolean
  restricted: boolean
  usernameError: string
  passwordError: string
  formError: string
  heading: string
  description: string
}

export function readLoginInPage(pinSelector: string): LoginSnapshot {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
  const visible = (el: Element | null) => {
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'
  }
  const firstText = (sel: string) => {
    const el = Array.from(document.querySelectorAll(sel)).find((e) => visible(e) && clean(e.textContent))
    return el ? clean(el.textContent) : ''
  }
  // Challenge pages say what they want in their headings and short paragraphs. Feed posts, articles
  // and comments are never read here: a post about "restricted accounts" is not a restriction.
  const FEED = '[data-urn], [data-id^="urn:li:"], .feed-shared-update-v2, article, [role="article"], .comments-comment-item, [data-view-name*="feed"]'
  const pageText = clean(
    Array.from(document.querySelectorAll('h1, h2, p, label, .content__subtitle, .form__subtitle'))
      .filter((e) => visible(e) && !e.closest(FEED))
      .map((e) => e.textContent)
      .join(' | '),
  ).slice(0, 5000)
  const heading = firstText('h1') || firstText('h2')
  const pinInput = Array.from(document.querySelectorAll(pinSelector)).some(visible)
  const errors = Array.from(document.querySelectorAll('.form__label--error, .alert-content, .body__banner--error, [role="alert"], .error, .input__message--error'))
    .filter((e) => visible(e) && !e.closest('#error-for-username, #error-for-password'))
    .map((e) => clean(e.textContent))
    .filter((t) => t && !/cookie/i.test(t))
  return {
    url: location.href,
    loggedIn: !!document.querySelector('#global-nav, .global-nav, [data-test-global-nav-me], img.global-nav__me-photo, header[data-test-global-nav]'),
    hasMain: !!document.querySelector('main, [role="main"]'),
    loginForm: !!document.querySelector('input#username, input[name="session_key"]') && !!document.querySelector('input#password, input[name="session_password"]'),
    pinInput,
    appApproval:
      !pinInput &&
      /(open|check) (your|the) linkedin app|approve (the |this |your )?sign[- ]?in|tap (yes|on the notification)|sent a notification to your/i.test(pageText),
    captcha:
      !!Array.from(
        document.querySelectorAll('iframe#captcha-internal, iframe[src*="captcha" i], iframe[src*="arkoselabs" i], iframe[title*="captcha" i], #captcha-challenge, .captcha-container'),
      ).some(visible) || /quick security check|security verification|verify (that )?you[’']?(re| are) (a )?human|i[’']m not a robot|solve (this|the) puzzle/i.test(heading),
    restricted: /account (has been |is )?(temporarily )?restricted|restricted your account/i.test(pageText),
    usernameError: firstText('#error-for-username'),
    passwordError: firstText('#error-for-password'),
    formError: Array.from(new Set(errors)).join(' ').slice(0, 300),
    heading,
    description: firstText('.form__subtitle, .content__subtitle, form p, main p').slice(0, 300),
  }
}

export type LoginState =
  | 'logged_in'
  | 'interstitial'
  | 'pin'
  | 'app_approval'
  | 'captcha'
  | 'restricted'
  | 'wrong_credentials'
  | 'login_error'
  | 'login_form'
  | 'challenge'
  | 'unknown'

const WRONG =
  /wrong (email|password)|not the right password|password you (provided|entered)|incorrect|couldn[’']t find a linkedin account|don[’']t recognize|doesn[’']t match|please enter a valid (username|email)|try again or (create|reset)/i

export function classifyLogin(s: LoginSnapshot): LoginState {
  let path = ''
  try {
    path = new URL(s.url).pathname
  } catch {
    return 'unknown'
  }
  if (/^\/check\//i.test(path)) return 'interstitial'
  const authPath = /^\/(login|uas\/|checkpoint\/|authwall|signup)/i.test(path)
  // LinkedIn's global navigation outside the sign-in / checkpoint pages: signed in, whatever the
  // page's content says (the challenge heuristics below only apply to the other pages).
  if (s.loggedIn && !authPath) return 'logged_in'
  if (s.pinInput) return 'pin'
  if (s.appApproval) return 'app_approval'
  if (s.captcha) return 'captcha'
  if (s.restricted) return 'restricted'
  if (/^\/feed(\/|$)/i.test(path) && s.hasMain && !s.loginForm) return 'logged_in'
  const err = s.passwordError || s.usernameError
  if (err) return WRONG.test(err) ? 'wrong_credentials' : 'login_error'
  if (s.loginForm && s.formError) return WRONG.test(s.formError) ? 'wrong_credentials' : 'login_error'
  if (s.loginForm) return 'login_form'
  if (/^\/checkpoint\//i.test(path)) return 'challenge'
  return 'unknown'
}

export interface LoginReading {
  state: LoginState
  snapshot: LoginSnapshot | null
}

/** Read the current sign-in state; 'unknown' while the page is navigating. */
export async function readLoginState(page: Page): Promise<LoginReading> {
  try {
    const snapshot = await page.evaluate(readLoginInPage, PIN_INPUT)
    return { state: classifyLogin(snapshot), snapshot }
  } catch {
    return { state: 'unknown', snapshot: null }
  }
}

/** States that may be a page in transition (redirecting, still rendering): never final while polling. */
export const TRANSIENT: LoginState[] = ['unknown', 'challenge']

/**
 * Poll until `done(reading)` (default: any state other than a plain login form or a transient one)
 * or the timeout. Returns the last reading.
 */
export async function waitForLogin(page: Page, timeoutMs: number, done?: (r: LoginReading) => boolean): Promise<LoginReading> {
  const deadline = Date.now() + timeoutMs
  const isDone = done ?? ((r: LoginReading) => r.state !== 'login_form' && !TRANSIENT.includes(r.state))
  let r: LoginReading = { state: 'unknown', snapshot: null }
  while (Date.now() < deadline) {
    if (page.isClosed()) return r
    r = await readLoginState(page)
    if (isDone(r)) return r
    await sleep(400)
  }
  return r
}
