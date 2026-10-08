/**
 * Fake LinkedIn (LINKEDIN_DRIVER=simulated) for local testing and demos. Accounts are persisted
 * exactly like the real driver; the people "on LinkedIn" live in memory and behave
 * deterministically based on a hash of their public id (see docs in the README / tests).
 *
 * Magic words – in the public id: "connected" (already a connection), "accepter" / "replier"
 * (always accept / reply), "notfound", "ratelimit" (invites), "flaky" (first 2 calls per action
 * fail with 'unknown'), "transient" (the first call fails with 'transient'), "nonote".
 * In the sign-in email: "+code" / "+app" (verification), "+expire" (signed out on the 3rd action),
 * "+lang" (LinkedIn not in English: Test and every action fail with 'account_problem').
 */
import type { LinkedInProfile } from '../../../shared/types.ts'
import { isValidSearchUrl, nameFromPublicId, publicIdFromUrl } from '../../../shared/linkedin-url.ts'
import type { Config } from '../config.ts'
import type { DB } from '../db/index.ts'
import { clearAccount, getAccount, loadSession, markExpired, updateAccount } from './accounts.ts'
import { createKeyedMutex, hash32, NON_ENGLISH_MESSAGE, sleep } from './common.ts'
import {
  type ConnectOutcome,
  type ConnectionStatus,
  LinkedInError,
  type LinkedInDriver,
  type LinkedInService,
  type ProfileData,
  type SearchPage,
  type SearchPerson,
} from './types.ts'

export const SIM_SESSION = { simulated: true } as const
export const SIM_CODE = '123456'
const PENDING_TTL_MS = 10 * 60_000
const SEARCH_TOTAL = 25
const SEARCH_PAGE_SIZE = 10

const FIRST = ['Aarav', 'Priya', 'Liam', 'Sofia', 'Noah', 'Mia', 'Arjun', 'Emma', 'Lucas', 'Ananya', 'Ethan', 'Olivia', 'Kabir', 'Chloe', 'Mateo', 'Isha', 'Daniel', 'Zara', 'Ravi', 'Hannah']
const LAST = ['Sharma', 'Johnson', 'Patel', 'Garcia', 'Müller', 'Chen', 'Kapoor', 'Williams', 'Rossi', 'Iyer', 'Brown', 'Nguyen', 'Mehta', 'Smith', 'Kowalski', 'Reddy', 'Martin', 'Silva', 'Das', 'Taylor']
const TITLES = ['Head of Growth', 'VP Sales', 'Founder & CEO', 'Product Manager', 'Engineering Manager', 'Marketing Director', 'CTO', 'Talent Acquisition Lead', 'Customer Success Manager', 'Operations Lead']
const COMPANIES = ['Acme Corp', 'Northwind', 'Globex', 'Initech', 'Umbrella Labs', 'Stark Industries', 'Wayne Enterprises', 'Hooli', 'Pied Piper', 'Vandelay Imports']
const LOCATIONS = ['Bengaluru, Karnataka, India', 'London, England, United Kingdom', 'San Francisco Bay Area', 'Berlin, Germany', 'Mumbai, Maharashtra, India', 'New York, United States', 'Toronto, Ontario, Canada', 'Singapore', 'Sydney, Australia', 'Dubai, United Arab Emirates']

interface SimMessage {
  from: 'me' | 'them'
  at: number
  text: string
}

interface Person {
  connection: ConnectionStatus
  acceptAt: number | null
  replyAt: number | null
  following: boolean
  liked: boolean
  /** oldest first */
  messages: SimMessage[]
  calls: Record<string, number>
  transientDone: boolean
}

const SIM_REPLY = 'Thanks for reaching out! Happy to chat.'
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Same rule as the real driver: the lead wrote after our message `after` (else after our latest message). */
export function simRepliedAfter(messages: SimMessage[], after: string | null): boolean {
  let anchor = -1
  if (after && norm(after)) {
    for (let i = messages.length - 1; i >= 0 && anchor < 0; i--) if (messages[i].from === 'me' && norm(messages[i].text) === norm(after)) anchor = i
  }
  if (anchor < 0) for (let i = messages.length - 1; i >= 0 && anchor < 0; i--) if (messages[i].from === 'me') anchor = i
  return messages.some((m, i) => m.from === 'them' && i > anchor)
}

/** Our latest message already is `text` (an earlier attempt delivered it). */
function simAlreadySent(messages: SimMessage[], text: string) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].from === 'me') return norm(messages[i].text) === norm(text)
  return false
}

interface Pending {
  kind: 'code' | 'app'
  email: string
  checks: number
  expiresAt: number
}

const pick = <T>(list: T[], h: number) => list[h % list.length]

/** Deterministic fake identity for a public id (search results and profile views agree). */
function fakeIdentity(id: string) {
  const h = hash32(id)
  const guess = nameFromPublicId(id)
  const generated = id.startsWith('sim-')
  const company = pick(COMPANIES, h >>> 3)
  return {
    firstName: generated ? pick(FIRST, h) : guess.firstName,
    lastName: generated ? pick(LAST, h >>> 5) : guess.lastName,
    headline: `${pick(TITLES, h >>> 7)} at ${company}`,
    company,
    location: pick(LOCATIONS, h >>> 11),
  }
}

/** "jane.doe+code@example.com" → "Jane Doe" */
export function nameFromEmail(email: string | null) {
  const local = (email ?? '').split('@')[0].split('+')[0]
  const words = local.split(/[._\-\s]+/).filter(Boolean)
  if (!words.length) return 'Simulated User'
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
}

const simProfile = (email: string | null): LinkedInProfile => ({
  name: nameFromEmail(email),
  headline: 'Simulated LinkedIn account',
  profileUrl: 'https://www.linkedin.com/in/simulated-user/',
  imageUrl: null,
})

const isSimSession = (s: unknown) => !!s && typeof s === 'object' && (s as { simulated?: unknown }).simulated === true

export function createSimulatedService(deps: { db: DB; config: Config }): LinkedInService {
  const { db, config } = deps
  const withLock = createKeyedMutex()
  const pending = new Map<string, Pending>()
  const world = new Map<string, Person>()
  const actionCounts = new Map<string, number>()
  const latency = () => sleep(config.sim.actionLatencyMs)

  function connect(userId: string, method: 'password' | 'cookie', email: string | null): ConnectOutcome {
    pending.delete(userId)
    const profile = simProfile(email)
    const account = updateAccount(db, userId, {
      status: 'connected',
      authMethod: method,
      email,
      profile,
      session: SIM_SESSION,
      lastError: null,
      lastCheckedAt: Date.now(),
    })
    return { account, message: `Connected as ${profile.name} (simulated LinkedIn).` }
  }

  function fail(userId: string, message: string, patch: { authMethod?: 'password' | 'cookie'; email?: string | null } = {}): ConnectOutcome {
    return { account: updateAccount(db, userId, { status: 'error', lastError: message, ...patch }), message }
  }

  /** The live pending sign-in, expiring it (status error) after 10 minutes. */
  function livePending(userId: string): Pending | 'timed_out' | null {
    const p = pending.get(userId)
    if (!p) return null
    if (Date.now() <= p.expiresAt) return p
    pending.delete(userId)
    updateAccount(db, userId, { status: 'error', lastError: 'Verification timed out. Please sign in again.' })
    return 'timed_out'
  }

  function nothingPending(userId: string, timedOut: boolean): ConnectOutcome {
    const account = getAccount(db, userId)
    if (timedOut) return { account, message: 'Verification timed out. Please sign in again.' }
    if (account.status === 'needs_verification' || account.status === 'needs_app_approval') {
      return fail(userId, 'This sign-in attempt is no longer active. Please sign in again.')
    }
    if (account.status === 'connected') return { account, message: 'Your LinkedIn account is already connected.' }
    return { account, message: 'There is no sign-in waiting for verification. Please sign in again.' }
  }

  /* ---------------------------- driver world ---------------------------- */

  function person(userId: string, id: string): Person {
    const key = `${userId}\u0000${id}`
    let p = world.get(key)
    if (!p) {
      const connected = id.includes('connected')
      p = {
        connection: connected ? 'connected' : 'not_connected',
        acceptAt: null,
        replyAt: null,
        following: connected,
        liked: false,
        messages: [],
        calls: {},
        transientDone: false,
      }
      world.set(key, p)
    }
    const now = Date.now()
    if (p.connection === 'pending' && p.acceptAt !== null && now >= p.acceptAt) {
      p.connection = 'connected'
      p.acceptAt = null
      p.following = true
    }
    if (p.replyAt !== null && now >= p.replyAt) {
      p.messages.push({ from: 'them', at: p.replyAt, text: SIM_REPLY })
      p.messages.sort((a, b) => a.at - b.at)
      p.replyAt = null
    }
    return p
  }

  /** Common prologue of every driver action: latency, the "+lang" / "+expire" rules, and per-id error rules. */
  async function begin(userId: string, action: string, profileUrl?: string) {
    await latency()
    const email = getAccount(db, userId).email ?? ''
    if (email.includes('+lang')) throw new LinkedInError('account_problem', NON_ENGLISH_MESSAGE)
    const n = (actionCounts.get(userId) ?? 0) + 1
    actionCounts.set(userId, n)
    if (n === 3 && email.includes('+expire')) {
      const message = 'LinkedIn signed you out (simulated). Reconnect your account in Settings.'
      markExpired(db, userId, message)
      throw new LinkedInError('session_expired', message)
    }
    if (profileUrl === undefined) return null
    const id = publicIdFromUrl(profileUrl)
    if (!id) throw new LinkedInError('not_found', 'Not a LinkedIn profile URL')
    if (id.includes('notfound')) throw new LinkedInError('not_found', 'This profile does not exist (simulated)')
    const p = person(userId, id)
    if (id.includes('transient') && !p.transientDone) {
      p.transientDone = true
      throw new LinkedInError('transient', "Couldn't reach LinkedIn (simulated network problem)")
    }
    if (id.includes('flaky')) {
      p.calls[action] = (p.calls[action] ?? 0) + 1
      if (p.calls[action] <= 2) throw new LinkedInError('unknown', 'LinkedIn did not respond in time (simulated flaky profile)')
    }
    return { id, p, h: hash32(id) }
  }

  function makeDriver(userId: string): LinkedInDriver {
    const at = async (action: string, url: string) => (await begin(userId, action, url))!
    return {
      async viewProfile(profileUrl): Promise<ProfileData> {
        const { id, p } = await at('viewProfile', profileUrl)
        const who = fakeIdentity(id)
        return { ...who, profileUrl: `https://www.linkedin.com/in/${encodeURIComponent(id)}/`, connection: p.connection }
      },
      async getConnectionStatus(profileUrl) {
        return (await at('getConnectionStatus', profileUrl)).p.connection
      },
      async sendInvite(profileUrl, note) {
        const { id, p, h } = await at('sendInvite', profileUrl)
        if (id.includes('ratelimit')) throw new LinkedInError('rate_limited', "You've reached the weekly invitation limit (simulated)")
        if (p.connection === 'connected') return 'already_connected'
        if (p.connection === 'pending') return 'pending'
        p.connection = 'pending'
        p.acceptAt = h % 10 < 7 || id.includes('accepter') ? Date.now() + config.sim.acceptAfterMs : null
        return note && id.includes('nonote') ? 'sent_without_note' : 'sent'
      },
      async sendMessage(profileUrl, text, opts) {
        const { id, p, h } = await at('sendMessage', profileUrl)
        if (p.connection !== 'connected') return 'not_connected'
        const body = text.trim()
        if (opts.stopIfRepliedAfter && simRepliedAfter(p.messages, opts.stopIfRepliedAfter.after)) return 'replied'
        if (simAlreadySent(p.messages, body)) return 'already_sent'
        const replied = p.messages.some((m) => m.from === 'them')
        const first = !p.messages.some((m) => m.from === 'me')
        p.messages.push({ from: 'me', at: Date.now(), text: body })
        if (first && !replied && (h % 10 < 4 || id.includes('replier'))) p.replyAt = Date.now() + config.sim.replyAfterMs
        return 'sent'
      },
      async hasReplied(profileUrl, check) {
        return simRepliedAfter((await at('hasReplied', profileUrl)).p.messages, check.after)
      },
      async follow(profileUrl) {
        const { p } = await at('follow', profileUrl)
        if (p.following) return 'already_following'
        p.following = true
        return 'followed'
      },
      async likeLatestPost(profileUrl) {
        const { p, h } = await at('likeLatestPost', profileUrl)
        if (h % 5 === 0) return 'no_posts'
        if (p.liked) return 'already_liked'
        p.liked = true
        return 'liked'
      },
      async withdrawInvite(profileUrl) {
        const { p } = await at('withdrawInvite', profileUrl)
        if (p.connection !== 'pending') return 'not_pending'
        p.connection = 'not_connected'
        p.acceptAt = null
        return 'withdrawn'
      },
      async searchPeople(searchUrl, page): Promise<SearchPage> {
        await begin(userId, 'searchPeople')
        if (!isValidSearchUrl(searchUrl)) throw new LinkedInError('action_unavailable', 'Not a LinkedIn people-search URL')
        const n = Math.max(1, Math.floor(page))
        const short = hash32(searchUrl.trim()).toString(36).slice(0, 6)
        const count = Math.max(0, Math.min(SEARCH_PAGE_SIZE, SEARCH_TOTAL - (n - 1) * SEARCH_PAGE_SIZE))
        const people: SearchPerson[] = []
        for (let i = 1; i <= count; i++) {
          const id = `sim-${short}-${n}-${i}`
          const { firstName, lastName, headline, location } = fakeIdentity(id)
          people.push({ profileUrl: `https://www.linkedin.com/in/${id}/`, firstName, lastName, headline, location })
        }
        return { people, hasMore: n * SEARCH_PAGE_SIZE < SEARCH_TOTAL }
      },
    }
  }

  return {
    kind: 'simulated',

    getAccount(userId) {
      const account = getAccount(db, userId)
      if ((account.status === 'needs_verification' || account.status === 'needs_app_approval') && !pending.has(userId)) {
        return updateAccount(db, userId, { status: 'error', lastError: 'The sign-in was interrupted. Please sign in again.' })
      }
      if (pending.has(userId)) livePending(userId)
      return getAccount(db, userId)
    },

    loginWithPassword(userId, rawEmail, password) {
      return withLock(userId, async () => {
        await latency()
        pending.delete(userId)
        const email = rawEmail.trim()
        if (!email || !password) return fail(userId, 'Enter your LinkedIn email and password.')
        if (password === 'wrong-password') return fail(userId, 'Wrong email or password', { authMethod: 'password', email })
        if (email.includes('+code') || email.includes('+app')) {
          const kind = email.includes('+code') ? 'code' : 'app'
          pending.set(userId, { kind, email, checks: 0, expiresAt: Date.now() + PENDING_TTL_MS })
          const account = updateAccount(db, userId, {
            status: kind === 'code' ? 'needs_verification' : 'needs_app_approval',
            authMethod: 'password',
            email,
            lastError: null,
          })
          const message =
            kind === 'code'
              ? `LinkedIn sent a verification code to ${email}. Enter it to finish connecting. (Simulated: the code is ${SIM_CODE}.)`
              : 'Open the LinkedIn app on your phone and tap "Yes" to approve this sign-in, then click "Check". (Simulated: approved on the second check.)'
          return { account, message }
        }
        return connect(userId, 'password', email)
      })
    },

    submitVerificationCode(userId, code) {
      return withLock(userId, async () => {
        await latency()
        const p = livePending(userId)
        if (p === null || p === 'timed_out' || p.kind !== 'code') return nothingPending(userId, p === 'timed_out')
        if (code.replace(/\s+/g, '') !== SIM_CODE) return fail(userId, "That code didn't work")
        return connect(userId, 'password', p.email)
      })
    },

    checkPendingLogin(userId) {
      return withLock(userId, async () => {
        await latency()
        const p = livePending(userId)
        if (p === null || p === 'timed_out') return nothingPending(userId, p === 'timed_out')
        if (p.kind === 'code') return { account: getAccount(db, userId), message: 'Enter the verification code LinkedIn sent you.' }
        p.checks++
        if (p.checks >= 2) return connect(userId, 'password', p.email)
        return { account: getAccount(db, userId), message: 'Still waiting for you to approve the sign-in in the LinkedIn app.' }
      })
    },

    connectWithCookie(userId, liAt) {
      return withLock(userId, async () => {
        await latency()
        pending.delete(userId)
        const value = liAt.trim().replace(/^li_at=/, '')
        if (value.length < 10 || value.includes('expired')) return fail(userId, 'That cookie is invalid or expired', { authMethod: 'cookie' })
        return connect(userId, 'cookie', null)
      })
    },

    test(userId) {
      return withLock(userId, async () => {
        await latency()
        const account = getAccount(db, userId)
        // Like the real driver: a stored session is tested even after an error (e.g. the language).
        if ((account.status === 'connected' || account.status === 'error') && isSimSession(loadSession(db, userId))) {
          if ((account.email ?? '').includes('+lang')) {
            const updated = updateAccount(db, userId, { status: 'error', lastCheckedAt: Date.now(), lastError: NON_ENGLISH_MESSAGE })
            return { ok: false, message: NON_ENGLISH_MESSAGE, account: updated }
          }
          const updated = updateAccount(db, userId, { status: 'connected', lastCheckedAt: Date.now(), lastError: null })
          return { ok: true, message: `Connected as ${updated.profile?.name ?? 'your LinkedIn account'} (simulated LinkedIn).`, account: updated }
        }
        if (account.status === 'connected') {
          const expired = markExpired(db, userId, 'Your LinkedIn session is no longer valid. Please reconnect.')
          return { ok: false, message: expired.lastError!, account: expired }
        }
        const fresh = getAccount(db, userId)
        const message =
          fresh.status === 'expired'
            ? 'Your LinkedIn session has expired. Please reconnect your account.'
            : fresh.status === 'needs_verification' || fresh.status === 'needs_app_approval'
              ? 'Finish signing in to LinkedIn first.'
              : 'Connect your LinkedIn account first.'
        return { ok: false, message, account: fresh }
      })
    },

    disconnect(userId) {
      return withLock(userId, async () => {
        pending.delete(userId)
        clearAccount(db, userId)
      })
    },

    withDriver(userId, fn) {
      return withLock(userId, async () => {
        const account = getAccount(db, userId)
        if (account.status !== 'connected') {
          throw new LinkedInError(
            'session_expired',
            account.status === 'expired' ? (account.lastError ?? 'LinkedIn session expired. Reconnect your account.') : 'Connect your LinkedIn account first.',
          )
        }
        if (!isSimSession(loadSession(db, userId))) {
          const message = 'Your LinkedIn session is no longer valid. Please reconnect.'
          markExpired(db, userId, message)
          throw new LinkedInError('session_expired', message)
        }
        try {
          return await fn(makeDriver(userId))
        } catch (e) {
          if (e instanceof LinkedInError && e.code === 'account_problem') updateAccount(db, userId, { status: 'error', lastError: e.message })
          throw e
        }
      })
    },

    async shutdown() {
      pending.clear()
    },
  }
}
