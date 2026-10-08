/**
 * LinkedInDriver on a real, logged-in Playwright page. Every action opens the person's profile
 * first (like a person would), acts on the profile's top card only, and verifies the result.
 */
import type { Locator, Page } from 'playwright'
import { isValidSearchUrl, normalizeProfileUrl } from '../../../../shared/linkedin-url.ts'
import { browserGone, errorMessage, NON_ENGLISH_MESSAGE, networkError, sleep } from '../common.ts'
import {
  type ConnectionStatus,
  type InviteResult,
  LinkedInError,
  type LinkedInDriver,
  type MessageResult,
  type ProfileData,
  type ReplyCheck,
  type SearchPage,
} from '../types.ts'
import {
  ACTION,
  alreadySent,
  bindConversationInPage,
  BTN,
  type CardAction,
  classifyConnection,
  classifyInviteUi,
  classifyPage,
  hasAction,
  hasReplyAfter,
  isAuthUrl,
  lastOwnMessage,
  listConversationsInPage,
  pageStateInPage,
  parseSearch,
  pickConversation,
  profileFromCard,
  readInviteUiInPage,
  readPostsInPage,
  readSearchInPage,
  readThreadInPage,
  readTopCardInPage,
  type ReplyContext,
  sameMessage,
  type ThreadSnapshot,
  type TopCard,
} from './dom.ts'
import { browseLightly, insertText, type Pacing, pause, scrollThrough, shortPause, typeLikeHuman } from './human.ts'

export { sameMessage }

export interface DriverOptions {
  pacing: Pacing
  /** our own LinkedIn name – only when read from our profile (a placeholder would mis-attribute messages) */
  ownName?: string | null
  ownProfileUrl?: string | null
  /** true once the server is shutting down: no new irreversible action (send, invite, follow…) starts */
  isClosing?: () => boolean
}

interface Matcher {
  label: RegExp
  text: RegExp
}

const M = {
  connect: { label: /Invite .+ to connect/i, text: /^\s*Connect\b/i },
  pending: { label: /^Pending\b|withdraw invitation/i, text: /^\s*Pending\b/i },
  message: { label: /^Message\b/i, text: /^\s*Message\b/i },
  follow: { label: /^Follow\b/i, text: /^\s*\+?\s*Follow\b/i },
  more: { label: /^More( actions)?$/i, text: /^\s*More\b/i },
  accept: { label: /^Accept\b/i, text: /^\s*Accept\b/i },
} satisfies Record<string, Matcher>

const EMPTY_CARD: TopCard = { url: '', found: false, name: '', headline: '', location: '', company: '', degree: null, imageUrl: null, actions: [] }
const CLOSED_THREAD: ThreadSnapshot = {
  open: false,
  title: '',
  messages: [],
  inmail: false,
  composerText: '',
  sendFound: false,
  sendDisabled: true,
  closeFound: false,
  error: '',
  loading: false,
}
/** Modal dialogs (withdraw, discard draft…) – never a messaging window, which also uses role="dialog". */
const MODAL = '.artdeco-modal, [role="alertdialog"], [role="dialog"]:not(.msg-overlay-conversation-bubble):not(.msg-overlay-list-bubble)'

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

interface ThreadLead {
  name: string
  profileUrl: string
}

/** Fit an invitation note into the textarea's limit, cutting at a word boundary. */
export function fitNote(note: string, max: number) {
  const n = note.trim()
  if (n.length <= max) return n
  const cut = n.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.7 ? cut.slice(0, space) : cut).trim()
}

/** First candidate that has a visible match, polling until the timeout. */
export async function firstVisible(candidates: Locator[], timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const c of candidates) {
      const l = c.filter({ visible: true }).first()
      if ((await l.count().catch(() => 0)) > 0) return l
    }
    if (Date.now() >= deadline) return null
    await sleep(200)
  }
}

export class PlaywrightDriver implements LinkedInDriver {
  readonly page: Page
  readonly opts: DriverOptions
  private readonly token = Math.random().toString(36).slice(2, 10)
  private leadUrl = ''
  /** the lead whose conversation window is bound (data-la-thread) while a message action runs */
  private threadLead: ThreadLead | null = null

  constructor(page: Page, opts: DriverOptions) {
    this.page = page
    this.opts = opts
  }

  private get p() {
    return this.opts.pacing
  }

  /* ----------------------------- public API ----------------------------- */

  viewProfile(profileUrl: string): Promise<ProfileData> {
    return this.run('Viewing the profile', async () => {
      const { status, card } = await this.connection(await this.openProfile(profileUrl))
      return profileFromCard(card, this.leadUrl, status === 'unknown' ? 'not_connected' : status)
    })
  }

  getConnectionStatus(profileUrl: string): Promise<ConnectionStatus> {
    return this.run('Checking the connection', async () => {
      const { status } = await this.connection(await this.openProfile(profileUrl))
      return status === 'unknown' ? 'not_connected' : status
    })
  }

  sendInvite(profileUrl: string, note: string | null): Promise<InviteResult> {
    return this.run('Sending the invitation', async () => {
      const { status, card } = await this.connection(await this.openProfile(profileUrl))
      if (status === 'connected') return 'already_connected'
      if (status === 'pending') return 'pending'
      // An open chat window must never be taken for (or clicked as) the invitation dialog.
      await this.closeAllConversations()
      if (hasAction(card, ACTION.accept)) {
        // They invited us: accepting connects us.
        const accept = await this.findInCard(M.accept)
        if (accept) {
          this.beforeIrreversible()
          await this.humanClick(accept)
          await pause(this.p)
          return 'already_connected'
        }
      }
      const connect = await this.findAction(M.connect)
      if (!connect) {
        const again = await this.connection(await this.readCard(), true)
        if (again.status === 'connected') return 'already_connected'
        if (again.status === 'pending') return 'pending'
        throw new LinkedInError('action_unavailable', 'LinkedIn shows no Connect option for this profile')
      }
      // Some profiles send the invitation on this click already (no dialog).
      this.beforeIrreversible()
      await this.humanClick(connect)
      return this.completeInvite(note)
    })
  }

  sendMessage(profileUrl: string, text: string, opts: { stopIfRepliedAfter?: ReplyCheck }): Promise<MessageResult> {
    return this.run('Sending the message', async () => {
      const message = text.trim()
      if (!message) throw new LinkedInError('action_unavailable', 'The message is empty')
      const { status, card } = await this.connection(await this.openProfile(profileUrl))
      if (status === 'pending' || status === 'not_connected') return 'not_connected'
      const thread = await this.openConversation(card)
      if (!thread) {
        if (status === 'unknown') return 'not_connected'
        throw new LinkedInError('action_unavailable', 'LinkedIn shows no Message option for this profile')
      }
      try {
        if (thread.inmail) return 'not_connected'
        const who = this.who(card, thread)
        const check = opts.stopIfRepliedAfter
        if (check && hasReplyAfter(thread, who, check.after)) return 'replied'
        // Idempotent: an earlier attempt may have delivered this message without confirming it.
        if (alreadySent(thread, who, message)) return 'already_sent'
        await this.typeMessage(message)
        const before = await this.readThread()
        // The lead may have answered while we were typing.
        if (check && before.open && hasReplyAfter(before, who, check.after)) {
          await this.clearComposer().catch(() => {})
          return 'replied'
        }
        await this.clickSend()
        await this.verifySent(message, before, who)
        return 'sent'
      } finally {
        await this.closeConversation()
      }
    })
  }

  hasReplied(profileUrl: string, check: ReplyCheck): Promise<boolean> {
    return this.run('Checking for a reply', async () => {
      const card = await this.openProfile(profileUrl)
      const thread = await this.openConversation(card)
      if (!thread) return false
      try {
        return !thread.inmail && hasReplyAfter(thread, this.who(card, thread), check.after)
      } finally {
        await this.closeConversation()
      }
    })
  }

  follow(profileUrl: string): Promise<'followed' | 'already_following'> {
    return this.run('Following', async () => {
      const card = await this.openProfile(profileUrl)
      if (hasAction(card, ACTION.following)) return 'already_following'
      const btn = await this.findAction(M.follow)
      if (!btn) {
        if (hasAction(await this.readCard(), ACTION.following)) {
          await this.closeMenu()
          return 'already_following'
        }
        await this.closeMenu()
        throw new LinkedInError('action_unavailable', 'LinkedIn shows no Follow option for this profile')
      }
      this.beforeIrreversible()
      await this.humanClick(btn)
      const ok = await this.until(async () => {
        await this.closeMenu()
        const c = await this.readCard()
        if (hasAction(c, ACTION.following)) return true
        const ui = await this.page.evaluate(readInviteUiInPage, '').catch(() => null)
        return !!ui?.toasts.some((t) => /you[’']?re now following|following/i.test(t))
      })
      if (!ok) {
        await this.reloadProfile()
        if (!hasAction(await this.readCard(), ACTION.following) && !(await this.menuHas(ACTION.following))) {
          throw new LinkedInError('unknown', 'LinkedIn did not confirm the follow')
        }
      }
      return 'followed'
    })
  }

  likeLatestPost(profileUrl: string): Promise<'liked' | 'already_liked' | 'no_posts'> {
    return this.run('Liking the latest post', async () => {
      const base = this.profileUrlOf(profileUrl)
      await this.goto(`${base}recent-activity/all/`, true)
      const deadline = Date.now() + this.p.elementTimeoutMs
      let info = { posts: 0, empty: false, like: 'missing' as 'pressed' | 'unpressed' | 'missing' }
      for (;;) {
        await this.check()
        info = await this.page.evaluate(readPostsInPage, this.token).catch(() => info)
        if (info.posts > 0 || info.empty || Date.now() > deadline) break
        await sleep(500)
      }
      if (!info.posts) return 'no_posts'
      await pause(this.p)
      await browseLightly(this.page, this.p)
      info = await this.page.evaluate(readPostsInPage, this.token)
      if (info.like === 'pressed') return 'already_liked'
      if (info.like === 'missing') throw new LinkedInError('action_unavailable', 'Could not find the Like button on the latest post')
      this.beforeIrreversible()
      await this.humanClick(this.page.locator(`[data-la-like="${this.token}"]`))
      const ok = await this.until(async () => (await this.page.evaluate(readPostsInPage, this.token)).like === 'pressed')
      if (!ok) throw new LinkedInError('unknown', 'LinkedIn did not confirm the like')
      return 'liked'
    })
  }

  withdrawInvite(profileUrl: string): Promise<'withdrawn' | 'not_pending'> {
    return this.run('Withdrawing the invitation', async () => {
      const { status } = await this.connection(await this.openProfile(profileUrl))
      if (status !== 'pending') return 'not_pending'
      await this.closeAllConversations()
      const pending = await this.findAction(M.pending)
      if (!pending) throw new LinkedInError('action_unavailable', 'Could not find the Pending button to withdraw the invitation')
      await this.humanClick(pending)
      const dialog = this.modals()
      const confirm = await firstVisible(
        [
          dialog.getByRole('button', { name: BTN.withdraw }),
          dialog.locator('button').filter({ hasText: BTN.withdraw }),
          this.openMenus().getByRole('button', { name: BTN.withdraw }),
          this.openMenus().getByRole('menuitem', { name: BTN.withdraw }),
        ],
        this.p.elementTimeoutMs,
      )
      if (!confirm) throw new LinkedInError('unknown', 'LinkedIn did not ask to confirm the withdrawal')
      this.beforeIrreversible()
      await this.humanClick(confirm)
      const ok = await this.until(async () => {
        const ui = await this.page.evaluate(readInviteUiInPage, '').catch(() => null)
        if (ui?.toasts.some((t) => /withdrawn/i.test(t))) return true
        return !ui?.dialogs.length && classifyConnection(await this.readCard()) !== 'pending'
      })
      if (!ok) {
        await this.reloadProfile()
        if ((await this.connection(await this.readCard())).status === 'pending') throw new LinkedInError('unknown', 'LinkedIn did not confirm the withdrawal')
      }
      return 'withdrawn'
    })
  }

  searchPeople(searchUrl: string, page: number): Promise<SearchPage> {
    return this.run('Collecting search results', async () => {
      if (!isValidSearchUrl(searchUrl)) throw new LinkedInError('action_unavailable', 'Not a LinkedIn people-search URL')
      const url = new URL(searchUrl.trim())
      url.searchParams.set('page', String(Math.max(1, Math.floor(page))))
      await this.goto(url.toString(), false)
      const deadline = Date.now() + this.p.elementTimeoutMs
      let snap = await this.page.evaluate(readSearchInPage).catch(() => null)
      while (!snap || (!snap.rows.length && !snap.noResults && !snap.limitReached)) {
        if (Date.now() > deadline) throw new LinkedInError('unknown', 'LinkedIn search results did not load')
        await sleep(500)
        await this.check()
        snap = await this.page.evaluate(readSearchInPage).catch(() => null)
      }
      if (snap.limitReached) throw new LinkedInError('rate_limited', "LinkedIn's monthly search limit was reached (commercial use limit)")
      if (snap.rows.length) {
        await pause(this.p)
        await scrollThrough(this.page, this.p)
        snap = (await this.page.evaluate(readSearchInPage).catch(() => null)) ?? snap
      }
      return parseSearch(snap)
    })
  }

  /* ------------------------------ plumbing ------------------------------ */

  /**
   * Turn unexpected (Playwright) errors into LinkedInError: 'transient' when the browser or the
   * network is the problem, else 'unknown' with a readable message.
   */
  private async run<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof LinkedInError) throw e
      if (this.page.isClosed() || browserGone(e)) throw new LinkedInError('transient', `${what} failed: the browser was closed or crashed`)
      if (isAuthUrl(this.page.url())) throw this.expired(this.page.url())
      const offline = networkError(e)
      if (offline) throw new LinkedInError('transient', offline)
      const msg = errorMessage(e).split('\n')[0]
      throw new LinkedInError('unknown', `${what} failed: ${/timeout/i.test(msg) ? 'LinkedIn took too long to respond' : msg}`)
    }
  }

  /** No new irreversible action (send, invite, follow, like, withdraw) once the server is shutting down. */
  private beforeIrreversible() {
    if (this.opts.isClosing?.()) throw new LinkedInError('transient', 'The server is shutting down; the action will run again after the restart')
  }

  private expired(url: string) {
    return new LinkedInError(
      'session_expired',
      /\/checkpoint\//i.test(url)
        ? 'LinkedIn asked for a security verification. Reconnect your LinkedIn account in Settings.'
        : 'LinkedIn signed this account out. Reconnect your LinkedIn account in Settings.',
    )
  }

  private profileUrlOf(profileUrl: string) {
    const url = normalizeProfileUrl(profileUrl)
    if (!url) throw new LinkedInError('not_found', 'Not a LinkedIn profile URL')
    this.leadUrl = url
    return url
  }

  private async goto(url: string, isProfile: boolean) {
    const page = this.page
    await page.evaluate(() => (window.onbeforeunload = null)).catch(() => {})
    let status: number | null = null
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.p.navTimeoutMs })
      status = res?.status() ?? null
    } catch (e) {
      if (isAuthUrl(page.url())) throw this.expired(page.url())
      const msg = errorMessage(e)
      // A client-side redirect can abort the original navigation; carry on if we landed on LinkedIn.
      if (!(/ERR_ABORTED|interrupted by another navigation/i.test(msg) && /linkedin\.com/i.test(page.url()))) {
        // No network, a navigation timeout or a dead browser are not this lead's fault.
        const offline = networkError(e)
        if (offline) throw new LinkedInError('transient', offline)
        if (/timeout/i.test(msg)) throw new LinkedInError('transient', 'LinkedIn took too long to load')
        if (page.isClosed() || browserGone(e)) throw new LinkedInError('transient', 'The browser was closed or crashed while opening LinkedIn')
        throw new LinkedInError('unknown', `Could not open LinkedIn: ${msg.split('\n')[0]}`)
      }
    }
    if (status === 429) throw new LinkedInError('rate_limited', 'LinkedIn says there were too many requests')
    if (status === 404 && isProfile) throw new LinkedInError('not_found', 'Profile not found')
    await this.check()
  }

  /** Throw for login redirects, a non-English interface, "page doesn't exist" and throttling pages. */
  private async check() {
    if (isAuthUrl(this.page.url())) throw this.expired(this.page.url())
    const state = await this.page.evaluate(pageStateInPage).catch(() => null)
    if (!state) return
    switch (classifyPage(state)) {
      case 'session_expired':
        throw this.expired(state.url)
      case 'not_english':
        throw new LinkedInError('account_problem', NON_ENGLISH_MESSAGE)
      case 'not_found':
        throw new LinkedInError('not_found', 'Profile not found')
      case 'rate_limited':
        throw new LinkedInError('rate_limited', 'LinkedIn says there were too many requests')
      case 'search_limit':
        throw new LinkedInError('rate_limited', "LinkedIn's monthly search limit was reached (commercial use limit)")
    }
  }

  private async readCard(): Promise<TopCard> {
    return this.page.evaluate(readTopCardInPage).catch(() => EMPTY_CARD)
  }

  private async openProfile(profileUrl: string): Promise<TopCard> {
    await this.goto(this.profileUrlOf(profileUrl), true)
    await this.waitForCard()
    await pause(this.p)
    await browseLightly(this.page, this.p)
    return this.readCard()
  }

  private async reloadProfile() {
    await this.goto(this.leadUrl, true)
    await this.waitForCard()
  }

  private async waitForCard(): Promise<TopCard> {
    const deadline = Date.now() + this.p.elementTimeoutMs
    for (;;) {
      await this.check()
      const card = await this.readCard()
      // The card carries the URL it was read on: a redirect between check() and the read must not count.
      if (isAuthUrl(card.url)) throw this.expired(card.url)
      const onProfile = card.found && /linkedin\.com\/in\//i.test(card.url)
      if (onProfile && (card.actions.length > 0 || card.degree)) return card
      if (Date.now() > deadline) {
        if (onProfile) return card
        throw new LinkedInError('unknown', 'The LinkedIn profile did not load')
      }
      await sleep(400)
    }
  }

  /**
   * Connection status from the top card. The "More" menu is opened when the visible card is not
   * conclusive (its items may only render once opened).
   */
  private async connection(card: TopCard, forceMenu = false): Promise<{ status: ConnectionStatus | 'unknown'; card: TopCard }> {
    let status = classifyConnection(card)
    const menuRendered = card.actions.some((a) => a.inMenu)
    const conclusive = status === 'connected' || status === 'pending' || (status === 'not_connected' && (hasAction(card, ACTION.connect) || menuRendered))
    if ((forceMenu || !conclusive) && hasAction(card, ACTION.more) && (await this.openMore())) {
      card = await this.readCard()
      status = classifyConnection(card)
      await this.closeMenu()
    }
    return { status, card }
  }

  private async menuHas(test: (a: CardAction) => boolean) {
    if (!(await this.openMore())) return false
    const has = hasAction(await this.readCard(), test)
    await this.closeMenu()
    return has
  }

  private card() {
    return this.page.locator('[data-la-topcard]').first()
  }

  private openMenus() {
    return this.page.locator('.artdeco-dropdown__content--is-open, [role="menu"]').filter({ visible: true })
  }

  /** Visible modal dialogs, never a chat window. */
  private modals() {
    return this.page
      .locator(MODAL)
      .filter({ visible: true })
      .filter({ hasNot: this.page.locator('.msg-form, [contenteditable="true"], [contenteditable=""]') })
  }

  private findInCard(m: Matcher, timeoutMs = 1500) {
    const card = this.card()
    return firstVisible(
      [card.getByRole('button', { name: m.label }), card.getByRole('link', { name: m.label }), card.locator('button, a, [role="button"]').filter({ hasText: m.text })],
      timeoutMs,
    )
  }

  private async findInMenu(m: Matcher): Promise<Locator | null> {
    if (!(await this.openMore())) return null
    const menu = this.openMenus()
    const found = await firstVisible(
      [
        menu.getByRole('button', { name: m.label }),
        menu.getByRole('menuitem', { name: m.label }),
        menu.locator('[role="button"], [role="menuitem"], button, a').filter({ hasText: m.text }),
      ],
      2500,
    )
    if (!found) await this.closeMenu()
    return found
  }

  /** The action in the top card, else in its "More" menu. */
  private async findAction(m: Matcher) {
    return (await this.findInCard(m)) ?? (await this.findInMenu(m))
  }

  private async openMore(): Promise<boolean> {
    if ((await this.openMenus().count()) > 0) return true
    const more = await this.findInCard(M.more, 1000)
    if (!more) return false
    await this.humanClick(more)
    return !!(await firstVisible([this.openMenus()], 3000))
  }

  private async closeMenu() {
    if ((await this.openMenus().count().catch(() => 0)) > 0) {
      await this.page.keyboard.press('Escape').catch(() => {})
      await sleep(200)
    }
  }

  private async humanClick(l: Locator) {
    await l.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
    await l.hover({ timeout: 5000 }).catch(() => {})
    await shortPause(this.p)
    await l.click({ timeout: this.p.elementTimeoutMs })
  }

  /** Poll `check` until true or the verify timeout. */
  private async until(check: () => Promise<boolean>, timeoutMs = this.p.verifyTimeoutMs) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await check().catch(() => false)) return true
      if (Date.now() >= deadline) return false
      await sleep(400)
    }
  }

  private who(card: TopCard, thread: ThreadSnapshot): ReplyContext {
    return { ownName: this.opts.ownName, ownProfileUrl: this.opts.ownProfileUrl, leadProfileUrl: this.leadUrl, leadName: card.name || thread.title }
  }

  /* ----------------------------- invitations ---------------------------- */

  /** The dialog the last readInviteUi() classified (never a chat window). */
  private dialog() {
    return this.page.locator(`[data-la-dialog="${this.token}"]`)
  }

  private readInviteUi() {
    return this.page.evaluate(readInviteUiInPage, this.token).catch(() => ({ dialogs: [], toasts: [] }))
  }

  private dialogButton(re: RegExp, timeoutMs = 1500) {
    const d = this.dialog()
    return firstVisible([d.getByRole('button', { name: re }), d.locator('button').filter({ hasText: re })], timeoutMs)
  }

  private async dismissDialog() {
    const d = this.dialog()
    const btn = await firstVisible([d.getByRole('button', { name: BTN.dismiss }), d.locator('button.artdeco-modal__dismiss, button[aria-label*="dismiss" i]')], 800)
    if (btn) await btn.click({ timeout: 3000 }).catch(() => {})
    else await this.page.keyboard.press('Escape').catch(() => {})
    await sleep(300)
  }

  private async completeInvite(note: string | null): Promise<InviteResult> {
    const wantNote = !!note?.trim()
    let addNoteClicked = false
    let noteSent = false
    let sendClicked = false
    let retriedConnect = false
    let noteAttempts = 0
    const result = (): InviteResult => (wantNote && !noteSent ? 'sent_without_note' : 'sent')
    const deadline = Date.now() + this.p.verifyTimeoutMs * 3

    while (Date.now() < deadline) {
      const { step, text, dialog } = classifyInviteUi(await this.readInviteUi())
      switch (step) {
        case 'limit':
          await this.dismissDialog()
          throw new LinkedInError('rate_limited', "LinkedIn's weekly invitation limit has been reached")
        case 'email':
          await this.dismissDialog()
          throw new LinkedInError('action_unavailable', "LinkedIn requires this person's email address to connect")
        case 'failed':
          throw new LinkedInError('unknown', `LinkedIn did not send the invitation: ${text.slice(0, 160)}`)
        case 'other':
          await this.dismissDialog()
          throw new LinkedInError('unknown', `Unexpected LinkedIn dialog: "${text.slice(0, 140)}"`)
        case 'sent':
          return result()
        case 'note': {
          if (++noteAttempts > 2) throw new LinkedInError('unknown', 'LinkedIn did not accept the invitation note')
          if (wantNote) {
            const box = this.dialog().locator('textarea').first()
            const value = fitNote(note!, dialog?.maxLength ?? 300)
            await box.click()
            await box.fill('')
            await typeLikeHuman(this.page, value, this.p)
            if (norm(await box.inputValue()) !== norm(value)) await box.fill(value)
          }
          await shortPause(this.p)
          const send = (await this.dialogButton(BTN.send)) ?? (await this.dialogButton(BTN.sendWithout))
          if (!send) throw new LinkedInError('unknown', 'Could not find the Send button in the invitation dialog')
          await this.until(() => send.isEnabled(), 5000)
          this.beforeIrreversible()
          await this.humanClick(send)
          sendClicked = true
          noteSent = wantNote
          await sleep(600)
          break
        }
        case 'choose': {
          if (wantNote && !addNoteClicked) {
            addNoteClicked = true
            const add = await this.dialogButton(BTN.addNote)
            if (add) {
              await this.humanClick(add)
              await shortPause(this.p)
              break
            }
          }
          const send = (await this.dialogButton(BTN.sendWithout)) ?? (await this.dialogButton(BTN.send))
          if (!send) throw new LinkedInError('unknown', 'Could not find the Send button in the invitation dialog')
          this.beforeIrreversible()
          await this.humanClick(send)
          sendClicked = true
          await sleep(600)
          break
        }
        case 'upsell': {
          // Free accounts get a limited number of notes: LinkedIn offers Premium instead of the note box.
          addNoteClicked = true
          const without = await this.dialogButton(BTN.sendWithout, 500)
          if (without) {
            this.beforeIrreversible()
            await this.humanClick(without)
            sendClicked = true
            await sleep(600)
            break
          }
          await this.dismissDialog()
          await sleep(500)
          const after = classifyInviteUi(await this.readInviteUi())
          if (after.step === 'none') {
            if (retriedConnect) throw new LinkedInError('unknown', 'LinkedIn did not let us send the invitation')
            retriedConnect = true
            const connect = await this.findAction(M.connect)
            if (!connect) throw new LinkedInError('unknown', 'The Connect button disappeared after the Premium prompt')
            this.beforeIrreversible()
            await this.humanClick(connect)
          }
          break
        }
        case 'none': {
          if (classifyConnection(await this.readCard()) === 'pending') return result()
          await sleep(400)
          break
        }
      }
    }

    if (sendClicked) {
      await this.reloadProfile()
      const { status } = await this.connection(await this.readCard())
      if (status === 'pending') return result()
      if (status === 'connected') return 'already_connected'
    }
    throw new LinkedInError('unknown', 'LinkedIn did not confirm the invitation was sent')
  }

  /* ------------------------------ messaging ----------------------------- */

  /** The bound conversation; when LinkedIn re-rendered it, the lead's window is bound again (never another one). */
  private async readThread(): Promise<ThreadSnapshot> {
    const read = () => this.page.evaluate(readThreadInPage, this.token).catch(() => CLOSED_THREAD)
    const t = await read()
    if (!t.open && this.threadLead && (await this.bindConversation(this.threadLead)).bound) return read()
    return t
  }

  /** Bind the open message window that belongs to `lead`; `other` names a window that is someone else's. */
  private async bindConversation(lead: ThreadLead): Promise<{ bound: boolean; other: string }> {
    const cands = await this.page.evaluate(listConversationsInPage, this.token).catch(() => [])
    if (!cands.length) return { bound: false, other: '' }
    const { key, other } = pickConversation(cands, lead)
    if (!key) return { bound: false, other }
    return { bound: await this.page.evaluate(bindConversationInPage, { token: this.token, key }).catch(() => false), other: '' }
  }

  private async unbindConversation() {
    this.threadLead = null
    await this.page.evaluate(bindConversationInPage, { token: this.token, key: '' }).catch(() => false)
  }

  private async closeAllConversations() {
    for (let i = 0; i < 6; i++) {
      const close = this.page.getByRole('button', { name: /^close your (draft )?conversation/i }).filter({ visible: true }).first()
      if (!(await close.count().catch(() => 0))) break
      await close.click({ timeout: 3000 }).catch(() => {})
      await this.confirmDiscard()
    }
  }

  private async confirmDiscard() {
    const discard = await firstVisible([this.modals().getByRole('button', { name: /^(discard|leave|close)$/i })], 500)
    if (discard) await discard.click({ timeout: 3000 }).catch(() => {})
  }

  /**
   * Open the message window with the profile's person and bind it (only a window whose header shows
   * this person); null when the profile has no Message action.
   */
  private async openConversation(card: TopCard): Promise<ThreadSnapshot | null> {
    await this.unbindConversation()
    await this.closeAllConversations()
    const top = this.card()
    const btn =
      (await firstVisible(
        [
          top.locator('a[href*="/messaging/compose/"]:not([href*="body="])'),
          top.getByRole('button', { name: M.message.label }),
          top.getByRole('link', { name: M.message.label }),
          top.locator('button, a').filter({ hasText: M.message.text }),
        ],
        1500,
      )) ?? (await this.findInMenu(M.message))
    if (!btn) return null
    await this.humanClick(btn)

    const lead: ThreadLead = { name: card.name, profileUrl: this.leadUrl }
    const deadline = Date.now() + this.p.elementTimeoutMs
    let other = ''
    for (;;) {
      const r = await this.bindConversation(lead)
      if (r.bound) break
      other = r.other || other
      // No message box but a Premium / InMail prompt: not a 1st-degree conversation.
      const ui = await this.readInviteUi()
      if (ui.dialogs.some((d) => /premium|inmail/i.test(d.text))) {
        await this.dismissDialog()
        return { ...CLOSED_THREAD, inmail: true }
      }
      if (Date.now() > deadline) {
        throw new LinkedInError(
          'unknown',
          other
            ? `The message window that opened is for “${other}”, not ${card.name || 'this person'} – nothing was sent`
            : 'The LinkedIn message window did not open',
        )
      }
      await sleep(400)
    }
    this.threadLead = lead
    try {
      return await this.waitForHistory()
    } catch (e) {
      await this.closeConversation()
      throw e
    }
  }

  /**
   * LinkedIn shows the message box before the conversation's history. Wait until no loader is shown
   * and the number of messages has settled; an empty conversation must stay empty (and without a
   * loader) for historySettleMs. Still loading at the timeout with nothing shown: an error, never
   * "no reply".
   */
  private async waitForHistory(): Promise<ThreadSnapshot> {
    const deadline = Date.now() + this.p.elementTimeoutMs
    const step = Math.max(150, this.p.shortPauseMs[1])
    await pause(this.p)
    let t = await this.readThread()
    let count = -1
    let loading = false
    let since = Date.now()
    for (;;) {
      if (!t.open) throw new LinkedInError('unknown', 'The LinkedIn message window closed while loading the conversation')
      const now = Date.now()
      const n = t.messages.length
      if (n !== count || t.loading !== loading) {
        count = n
        loading = t.loading
        since = now
      }
      const stable = now - since
      if (!t.loading && stable >= (n > 0 ? step : this.p.historySettleMs)) return t
      // A loader that stays while messages are shown (e.g. for older history): the latest are there.
      if (t.loading && n > 0 && stable >= this.p.historySettleMs) return t
      if (now > deadline) {
        if (n > 0 || !t.loading) return t
        throw new LinkedInError('unknown', 'LinkedIn did not finish loading the conversation')
      }
      await sleep(step)
      t = await this.readThread()
    }
  }

  private composer() {
    return this.page.locator(`[data-la-composer="${this.token}"]`)
  }

  private async clearComposer() {
    await this.composer().click({ timeout: this.p.elementTimeoutMs })
    await this.page.keyboard.press('ControlOrMeta+A')
    await this.page.keyboard.press('Backspace')
  }

  /** Type into the bound conversation's message box (never another window's). */
  private async typeMessage(text: string) {
    let t = await this.readThread()
    if (!t.open) throw new LinkedInError('unknown', 'The LinkedIn message window closed before the message was typed')
    await this.humanClick(this.composer())
    // A draft left by an earlier attempt would be sent along with the message.
    if (norm(t.composerText)) await this.clearComposer()
    await typeLikeHuman(this.page, text, this.p)
    await shortPause(this.p)
    t = await this.readThread()
    if (t.open && sameMessage(t.composerText, text)) return
    if (!t.open) throw new LinkedInError('unknown', 'The LinkedIn message window closed while the message was typed')
    // Some editors drop synthetic key events: clear this conversation's box and insert the text directly.
    await this.clearComposer()
    await insertText(this.page, text, this.p)
    await shortPause(this.p)
    t = await this.readThread()
    if (!t.open || !sameMessage(t.composerText, text)) {
      throw new LinkedInError('unknown', "Couldn't type the message into LinkedIn's message box")
    }
  }

  private async clickSend() {
    let t = await this.readThread()
    const deadline = Date.now() + 5000
    while (t.open && (!t.sendFound || t.sendDisabled) && Date.now() < deadline) {
      await sleep(250)
      t = await this.readThread()
    }
    if (!t.open) throw new LinkedInError('unknown', 'The LinkedIn message window closed before the message was sent')
    if (!t.sendFound) throw new LinkedInError('unknown', "Couldn't find LinkedIn's Send button")
    if (t.sendDisabled) throw new LinkedInError('unknown', "LinkedIn's Send button stayed disabled")
    this.beforeIrreversible()
    await this.humanClick(this.page.locator(`[data-la-send="${this.token}"]`))
  }

  /**
   * Confirm from the new message only: our latest message is the text just sent, the box was
   * emptied, and LinkedIn does not flag that message (or the window) with a send error. Words in
   * older messages never matter.
   */
  private async verifySent(text: string, before: ThreadSnapshot, who: ReplyContext) {
    const prev = lastOwnMessage(before, who)
    // Only possible when that earlier copy failed (else it was 'already_sent'): then the thread must grow.
    const prevSame = !!prev && sameMessage(prev.text, text)
    const isNew = (t: ThreadSnapshot) => {
      const mine = lastOwnMessage(t, who)
      return !!mine && sameMessage(mine.text, text) && (!prevSame || t.messages.length > before.messages.length) ? mine : null
    }
    let t = before
    let outcome = null as 'sent' | 'failed' | null
    await this.until(async () => {
      t = await this.readThread()
      if (!t.open) return false
      const mine = isNew(t)
      if (mine?.failed || (t.error && t.error !== before.error)) outcome = 'failed'
      else if (mine && !norm(t.composerText)) outcome = 'sent'
      return outcome !== null
    })
    if (outcome === 'sent') {
      // LinkedIn shows the message right away and flags it a moment later when delivery fails.
      await sleep(Math.max(300, this.p.shortPauseMs[1]))
      const again = await this.readThread()
      if (!(again.open && (isNew(again)?.failed || (again.error && again.error !== before.error)))) return
      t = again
      outcome = 'failed'
    }
    if (outcome === 'failed') throw new LinkedInError('unknown', `LinkedIn could not send the message${t.error ? `: ${t.error}` : ''}`)
    throw new LinkedInError('unknown', 'LinkedIn did not confirm the message was sent')
  }

  private async closeConversation() {
    await this.page.evaluate(() => (window.onbeforeunload = null)).catch(() => {})
    this.threadLead = null
    const t = await this.readThread()
    if (t.open && t.closeFound) {
      await this.page.locator(`[data-la-close="${this.token}"]`).click({ timeout: 3000 }).catch(() => {})
      await this.confirmDiscard()
    }
    await this.unbindConversation()
  }
}
