/**
 * A tiny fake linkedin.com built from the HTML fixtures: sign-in (password, PIN challenge, app
 * approval, captcha), li_at sessions, the feed, profiles (scripted, with persisted state),
 * recent activity and people search. Used through request routing; nothing leaves the machine.
 */
import { cookieOf, fixture, form, type Handler, type Reply } from './linkedin-browser.ts'

export interface ProfileConfig {
  name?: string
  degree?: string
  state?: 'not_connected' | 'pending' | 'connected'
  layout?: 'connect' | 'follow-primary'
  lazyMenu?: boolean
  mode?: 'normal' | 'upsell' | 'limit' | 'email' | 'direct'
  following?: boolean
  thread?: { from: 'me' | 'them'; text: string; failed?: boolean }[]
  replyOnSend?: boolean
  posts?: 'posts' | 'none'
  liked?: boolean
  /** extra About text (also rendered as a heading) */
  about?: string
  /** another person's chat window that pops up on page load, on the Connect click, or when we start typing */
  chat?: { name: string; id?: string; on: 'load' | 'connect' | 'type'; draft?: string }
  /** the message history arrives this long after the window opens (with a loader unless historyLoader is false) */
  historyDelayMs?: number
  historyLoader?: boolean
  /** the sent message is flagged "Failed to send" */
  sendFails?: boolean
  /** false: the message is delivered, but the window never shows it (nor empties the box) */
  confirm?: boolean
  /** false: no "--other" class and no sender links in the thread */
  markers?: boolean
  /** the page's <html lang> (default: site.uiLang) */
  lang?: string
}

export const PIN = '123456'

export function fakeSite() {
  let n = 0
  const site = {
    /** li_at values that are logged in */
    sessions: new Set<string>(),
    profiles: new Map<string, ProfileConfig>(),
    appApproved: false,
    /** LinkedIn's interface language (<html lang>) for the signed-in pages */
    uiLang: 'en',
    /** /in/me/ does not lead to the member's profile (the own profile can't be read) */
    meBroken: false,
    /** the search page shows LinkedIn's monthly-limit banner */
    searchLimitBanner: false,
    /** a search result's headline mentions the commercial use limit */
    searchLimitHeadline: false,
    /** emails that tried to sign in (passwords are never recorded) */
    logins: [] as string[],
    visits: [] as string[],
    newSession() {
      const v = `AQEDAR-session-${++n}`
      site.sessions.add(v)
      return v
    },
    handler: (async () => '') as Handler,
  }

  const signIn = (): Reply => ({
    location: '/feed/',
    headers: { 'set-cookie': `li_at=${site.newSession()}; Domain=.linkedin.com; Path=/; Secure; HttpOnly; SameSite=None` },
  })
  const login = (error = '') =>
    fixture('login.html', {
      USERNAME: '',
      USERNAME_ERROR: '',
      USERNAME_ERROR_CLASS: 'hidden__imp',
      PASSWORD_ERROR: error,
      PASSWORD_ERROR_CLASS: error ? '' : 'hidden__imp',
    })
  const pin = (error = '') => fixture('checkpoint-pin.html', { ERROR: error, ERROR_CLASS: error ? '' : 'hidden__imp' })
  const lang = (html: string) => html.replace('<html lang="en">', `<html lang="${site.uiLang}">`)

  site.handler = async (url, req) => {
    const path = url.pathname
    const post = req.method() === 'POST'
    site.visits.push(path)

    // Sign-in flow (no session needed).
    if (path === '/login' || path === '/uas/login') return login()
    if (path === '/checkpoint/lg/login-submit' && post) {
      const f = form(req)
      site.logins.push(f.session_key)
      if (f.session_password === 'wrong') return login('Wrong email or password. Try again or create an account.')
      if (f.session_key.includes('pin')) return { location: '/checkpoint/challenge/AgPin' }
      if (f.session_key.includes('app')) return { location: '/checkpoint/challenge/AgApp' }
      if (f.session_key.includes('captcha')) return { location: '/checkpoint/challenge/AgCaptcha' }
      if (f.session_key.includes('phone')) return { ...signIn(), location: '/check/add-phone' }
      return signIn()
    }
    if (path === '/checkpoint/challenge/AgPin') return pin()
    if (path === '/checkpoint/challenge/verify' && post) {
      return form(req).pin === PIN ? signIn() : pin('The verification code you entered isn’t valid. Please check the code and try again.')
    }
    if (path === '/checkpoint/challenge/AgApp') return fixture('checkpoint-app.html')
    if (path === '/checkpoint/challenge/app-status') return { body: JSON.stringify({ approved: site.appApproved }), contentType: 'application/json' }
    if (path === '/checkpoint/challenge/approved') return signIn()
    if (path === '/checkpoint/challenge/AgCaptcha') return fixture('checkpoint-captcha.html')
    if (path === '/__fake/state' && post) {
      const s = JSON.parse(req.postData() ?? '{}') as ProfileConfig & { id: string }
      site.profiles.set(s.id, { ...site.profiles.get(s.id), state: s.state, following: s.following, thread: s.thread })
      return { body: '{}', contentType: 'application/json' }
    }

    const li = await cookieOf(req, 'li_at')
    if (!li || !site.sessions.has(li)) {
      return path.startsWith('/in/') ? { location: `/authwall?sessionRedirect=${encodeURIComponent(url.toString())}` } : { location: '/login' }
    }
    if (path === '/check/add-phone') {
      return `<!doctype html><html><body><main><h1>Add a phone number</h1><p>Add a phone number for security.</p><button type="button" onclick="location.href='/feed/'">Skip</button></main></body></html>`
    }
    if (path === '/feed/') return lang(fixture('feed.html'))
    if (path === '/in/me/') return site.meBroken ? { status: 404, body: fixture('page-not-found.html') } : { location: '/in/sam-sender/' }
    if (path === '/in/sam-sender/')
      return lang(fixture('profile-1st.html').split('Jane Doe').join('Sam Sender').split('Head of Growth at Acme Corp | B2B SaaS | Speaker').join('Founder at Outbound Co'))
    if (path === '/in/ghost/') return { status: 404, body: fixture('page-not-found.html') }

    const activity = /^\/in\/([^/]+)\/recent-activity\/all\/$/.exec(path)
    if (activity) {
      const cfg = site.profiles.get(decodeURIComponent(activity[1])) ?? {}
      return fixture('recent-activity.html', { POSTS: cfg.posts ?? 'posts', LIKED: cfg.liked ? 'liked' : 'no' })
    }
    const profile = /^\/in\/([^/]+)\/$/.exec(path)
    if (profile) {
      const id = decodeURIComponent(profile[1])
      const cfg = site.profiles.get(id) ?? {}
      return fixture('profile-interactive.html', { CONFIG: JSON.stringify({ id, ...cfg }), LANG: cfg.lang ?? site.uiLang })
    }
    if (path === '/search/results/people/') {
      let html = fixture(url.searchParams.get('page') === '2' ? 'search-obfuscated.html' : 'search-results.html')
      if (site.searchLimitHeadline) html = html.replace('VP Marketing at Globex', 'VP Marketing at Globex | Prospecting without hitting the commercial use limit')
      if (site.searchLimitBanner) {
        html = html.replace(
          '<div class="search-results-container">',
          '<div class="search-results-container"><div class="search-paywall__info artdeco-card"><h2>You’ve reached the monthly limit for profile searches</h2><p>Upgrade to Premium to keep searching.</p></div>',
        )
      }
      return lang(html)
    }
    return { status: 404, body: fixture('page-not-found.html') }
  }
  return site
}

export type FakeSite = ReturnType<typeof fakeSite>
