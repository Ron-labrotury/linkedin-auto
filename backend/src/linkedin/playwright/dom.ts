/**
 * Reading LinkedIn pages. LinkedIn's markup changes often and uses obfuscated class names, so
 * every reader combines semantic hints (roles, aria-labels, visible text, URL shapes) with the
 * long-lived class names as a bonus.
 *
 * Functions named `*InPage` run inside the browser via page.evaluate: they must be
 * self-contained (no references to anything outside their body). Their results are plain data,
 * interpreted by the pure functions below, which are unit-tested against HTML fixtures.
 */
import { normalizeProfileUrl, publicIdFromUrl } from '../../../../shared/linkedin-url.ts'
import { isEnglishUi, normalizeName, sameName, splitName } from '../common.ts'
import type { ConnectionStatus, ProfileData, SearchPage, SearchPerson } from '../types.ts'

/* ------------------------------------------------------------------ */
/* Page state                                                          */
/* ------------------------------------------------------------------ */

export interface PageState {
  url: string
  loggedIn: boolean
  authwall: boolean
  notFound: boolean
  rateLimited: boolean
  searchLimit: boolean
  /** `<html lang>`: LinkedIn renders it in the member's interface language */
  lang: string
}

export function pageStateInPage(): PageState {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
  const heads = Array.from(document.querySelectorAll('h1, h2, h3'))
    .map((e) => clean(e.textContent))
    .join(' | ')
  // Error / throttling pages are recognised by their own heading only: the page's h1 or the error
  // template's heading – never section headings, posts or a profile's About text.
  const errorHeads = Array.from(document.querySelectorAll('h1, [class*="error-page"] h2, [class*="error-container"] h2'))
    .map((e) => clean(e.textContent))
    .join(' | ')
  const bodyText = clean(document.body ? document.body.innerText : '').slice(0, 4000)
  const loggedIn = !!document.querySelector(
    '#global-nav, .global-nav, nav.global-nav__content, [data-test-global-nav-me], .global-nav__me, img.global-nav__me-photo, header[data-test-global-nav]',
  )
  const authwall =
    !!document.querySelector(
      '.authwall-join-form, form.join-form, .join-form, [data-tracking-control-name*="auth_wall"], [data-tracking-control-name*="public_profile_nav"], [data-tracking-control-name*="guest_homepage"], .authwall-sign-in-form',
    ) || /^(sign in|join linkedin|join now)\b/i.test(heads)
  const path = location.pathname

  // The monthly search limit only exists on search pages, and only LinkedIn's own banner says it:
  // search result rows (headlines, insights) are left out.
  let searchLimit = false
  if (/^\/search\//i.test(path)) {
    const main = document.querySelector('main') ?? document.body
    const LIMIT = /commercial use limit|reached the monthly limit|monthly limit for (profile )?search/i
    const rows: Element[] = []
    main.querySelectorAll('a[href*="/in/"]').forEach((a) => {
      const row = a.closest('li, [data-chameleon-result-urn], [data-view-name*="search-entity-result"], .entity-result')
      if (row && !rows.includes(row)) rows.push(row)
    })
    const banners = Array.from(
      main.querySelectorAll('[class*="paywall"], [class*="upsell"], [class*="search-limit"], [class*="no-results"], [class*="empty-state"], [role="alert"]'),
    ).map((e) => clean(e.textContent))
    let rest = ''
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n && rest.length < 8000; n = walker.nextNode()) {
      const p = n.parentElement
      if (!p || p.closest('script, style, template') || rows.some((r) => r.contains(p))) continue
      rest += ' ' + (n.textContent ?? '')
    }
    searchLimit = LIMIT.test(banners.join(' | ')) || LIMIT.test(clean(rest))
  }
  return {
    url: location.href,
    loggedIn,
    authwall,
    notFound:
      /^\/(404|in\/unavailable)(\/|$)/i.test(path) ||
      /page (doesn[’']t|does not) exist|page not found|this profile is not available|profile (is )?unavailable|this page isn[’']t available/i.test(errorHeads),
    rateLimited:
      /too many requests|you[’']ve made too many|you are making too many/i.test(errorHeads) ||
      // A bare throttling page (no LinkedIn navigation around it), never a short profile.
      (!loggedIn && bodyText.length < 600 && /too many requests/i.test(bodyText)),
    searchLimit,
    lang: clean(document.documentElement.getAttribute('lang')),
  }
}

/** `<html lang>` of the current page ("" when not set). */
export function uiLanguageInPage(): string {
  return (document.documentElement.getAttribute('lang') ?? '').trim()
}

/** Login / authwall / checkpoint URLs: the session is gone (or LinkedIn wants a verification). */
export function isAuthUrl(url: string) {
  try {
    const u = new URL(url)
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return false
    return /^\/(login|authwall|signup|uas\/login|checkpoint\/|m\/login)/i.test(u.pathname)
  } catch {
    return false
  }
}

export type PageVerdict = 'ok' | 'session_expired' | 'not_english' | 'not_found' | 'rate_limited' | 'search_limit'

export function classifyPage(s: PageState): PageVerdict {
  if (isAuthUrl(s.url)) return 'session_expired'
  if (!s.loggedIn && s.authwall) return 'session_expired'
  // Every reader below relies on LinkedIn's English labels.
  if (!isEnglishUi(s.lang)) return 'not_english'
  if (s.notFound) return 'not_found'
  if (s.rateLimited) return 'rate_limited'
  if (s.searchLimit) return 'search_limit'
  return 'ok'
}

/* ------------------------------------------------------------------ */
/* Profile top card                                                    */
/* ------------------------------------------------------------------ */

export interface CardAction {
  label: string
  text: string
  href: string
  inMenu: boolean
  disabled: boolean
}

export interface TopCard {
  /** page URL when the card was read */
  url: string
  found: boolean
  name: string
  headline: string
  location: string
  company: string
  /** "1st" | "2nd" | "3rd" | "3rd+" when shown */
  degree: string | null
  imageUrl: string | null
  /** buttons/links of the top card, including (possibly hidden) items of its "More" menu */
  actions: CardAction[]
}

/**
 * Reads the profile top card (the section holding the h1 name) and marks it with
 * `data-la-topcard` so locators can be scoped to it (never "People also viewed").
 */
export function readTopCardInPage(): TopCard {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
  const HIDDEN = '.visually-hidden, .sr-only, .a11y-text, script, style, template, [hidden], svg'
  const ACTIONS = '[role="menu"], .artdeco-dropdown__content, button, [role="button"], [role="menuitem"]'
  const visibleText = (el: Element | null): string => {
    if (!el) return ''
    let out = ''
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement
      if (p && p.closest(HIDDEN)) continue
      out += ' ' + (n.textContent ?? '')
    }
    return clean(out)
  }
  const rendered = (el: Element) => el.getClientRects().length > 0
  const empty: TopCard = { url: location.href, found: false, name: '', headline: '', location: '', company: '', degree: null, imageUrl: null, actions: [] }

  const main = document.querySelector('main') ?? document.body
  if (!main) return empty
  const h1 = Array.from(main.querySelectorAll('h1')).find((h) => rendered(h) && !h.closest(HIDDEN) && visibleText(h))
  if (!h1) return empty

  // The top card: the h1's section, unless that section wraps the whole profile.
  let root: Element | null = h1.closest('section')
  if (root && (root.querySelector('section') || root.querySelectorAll('h2').length > 2)) root = null
  if (!root) {
    root = h1
    for (let el = h1.parentElement, i = 0; el && el !== main && i < 10; el = el.parentElement, i++) {
      if (el.querySelectorAll('h2').length > 1) break
      root = el
      if (el.querySelector('button') && i >= 2) break
    }
  }
  document.querySelectorAll('[data-la-topcard]').forEach((e) => e !== root && e.removeAttribute('data-la-topcard'))
  root.setAttribute('data-la-topcard', '1')

  // Actions in the card + items of any open menu rendered elsewhere (portals, shadow roots).
  const seen = new Set<Element>()
  const actionEls: Element[] = []
  const add = (el: Element) => {
    if (!seen.has(el)) {
      seen.add(el)
      actionEls.push(el)
    }
  }
  root.querySelectorAll('button, a[role="button"], [role="button"], [role="menuitem"], a[href*="/messaging/compose"]').forEach(add)
  const roots: (Document | ShadowRoot)[] = [document]
  document.querySelectorAll('*').forEach((el) => el.shadowRoot && roots.push(el.shadowRoot))
  for (const r of roots) {
    r.querySelectorAll('[role="menu"], .artdeco-dropdown__content--is-open').forEach((menu) => {
      if (root!.contains(menu) || !rendered(menu)) return
      menu.querySelectorAll('[role="button"], [role="menuitem"], button, a').forEach(add)
    })
  }
  const actions = actionEls.map((el) => ({
    label: clean(el.getAttribute('aria-label')) || visibleText(el),
    text: visibleText(el),
    href: (el as HTMLAnchorElement).href ?? '',
    inMenu: !!el.closest('[role="menu"], .artdeco-dropdown__content'),
    disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
  }))

  // Connection degree ("· 1st", or the screen-reader "1st degree connection").
  let degree: string | null = null
  for (const el of Array.from(root.querySelectorAll('span, div, p, li'))) {
    if (el.children.length > 2 || el.closest(ACTIONS)) continue
    const m = /^(?:[·•]\s*)?(1st|2nd|3rd\+?)(?:\s+degree(?:\s+connection)?)?$/i.exec(clean(el.textContent))
    if (m) {
      degree = m[1].toLowerCase()
      break
    }
  }

  // Text runs of the card in document order (for the headline fallback).
  const runs: { el: Element; text: string }[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let last: Element | null = null
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const p = n.parentElement
    const t = clean(n.textContent)
    if (!p || !t || p.closest(HIDDEN) || p.closest(ACTIONS) || p.closest('a[href*="contact-info"]')) continue
    if (p === last) runs[runs.length - 1].text += ' ' + t
    else runs.push({ el: p, text: t })
    last = p
  }
  const name = visibleText(h1)
  const NOISE = /^([·•|]|(?:[·•]\s*)?(1st|2nd|3rd\+?)( degree( connection)?)?|(he|she|they|ze|xe)\s*\/\s*\w+|verified|premium|open to work|hiring|contact info|\d[\d,]*\+? (followers|connections))$/i
  let headline = clean(visibleText(root.querySelector('.text-body-medium.break-words, [data-generated-suggestion-target]')))
  if (!headline) {
    const start = runs.findIndex((r) => h1.contains(r.el))
    for (let i = start + 1; start >= 0 && i < runs.length; i++) {
      const t = runs[i].text
      if (h1.contains(runs[i].el) || NOISE.test(t) || t === name || t.length < 2) continue
      headline = t
      break
    }
  }

  // Location: the text next to the "Contact info" link.
  let loc = ''
  const contact = root.querySelector('a[href*="contact-info"], #top-card-text-details-contact-info')
  for (let el = contact?.parentElement ?? null, i = 0; el && i < 4; el = el.parentElement, i++) {
    const t = clean(visibleText(el).replace(/contact info/gi, ' ').replace(/[·•]/g, ' '))
    if (t) {
      if (t.length <= 120 && t !== headline && !t.includes(name)) loc = t
      break
    }
    if (el === root) break
  }
  if (!loc) loc = visibleText(root.querySelector('.text-body-small.inline.t-black--light.break-words'))

  const companyEl = root.querySelector('[aria-label^="Current company" i]')
  const company = companyEl
    ? clean(companyEl.getAttribute('aria-label'))
        .replace(/^current company:?\s*/i, '')
        .replace(/\.?\s*click to skip.*$/i, '')
    : ''

  const img = Array.from(root.querySelectorAll('img')).find(
    (i) => /profile-displayphoto/i.test(i.src) || /profile-picture|pv-top-card-profile-picture/i.test(i.className),
  )
  const imageUrl = img && /^https?:/i.test(img.src) && !/displaybackgroundimage/i.test(img.src) ? img.src : null

  return { url: location.href, found: true, name, headline, location: loc, company, degree, imageUrl, actions }
}

type ActionTest = (a: CardAction) => boolean

/** Recognisers for top-card actions, by aria-label first and visible text second. */
export const ACTION: Record<'connect' | 'pending' | 'remove' | 'message' | 'follow' | 'following' | 'more' | 'accept', ActionTest> = {
  connect: (a) => /^invite .+ to connect$/i.test(a.label) || /^connect$/i.test(a.text),
  pending: (a) => /^pending\b/i.test(a.label) || /withdraw invitation/i.test(a.label) || /^pending$/i.test(a.text),
  remove: (a) => /^remove (your )?connection\b/i.test(a.label) || /^remove connection$/i.test(a.text),
  message: (a) => /^message\b/i.test(a.label) || /^message$/i.test(a.text) || (/\/messaging\/compose/i.test(a.href) && !/[?&]body=/i.test(a.href)),
  follow: (a) => /^follow\b/i.test(a.label) || /^\+?\s*follow$/i.test(a.text),
  following: (a) => /^(following|unfollow)\b/i.test(a.label) || /^(following|unfollow)$/i.test(a.text),
  more: (a) => /^more( actions)?$/i.test(a.label) || /^more$/i.test(a.text),
  accept: (a) => /^accept\b/i.test(a.label) || /^accept$/i.test(a.text),
}

export const hasAction = (card: TopCard, test: ActionTest) => card.actions.some(test)

/** 'unknown' when the card shows neither a degree nor any connect/pending hint. */
export function classifyConnection(card: TopCard): ConnectionStatus | 'unknown' {
  if (card.degree === '1st' || hasAction(card, ACTION.remove)) return 'connected'
  if (hasAction(card, ACTION.pending)) return 'pending'
  if (card.degree || hasAction(card, ACTION.connect) || hasAction(card, ACTION.accept)) return 'not_connected'
  return 'unknown'
}

/** " at Acme Corp | Speaker" → "Acme Corp" */
export function companyFromHeadline(headline: string) {
  const m = /(?:\bat|@)\s+([^|•·,;]+?)\s*(?:[|•·,;]|$)/i.exec(headline)
  return m ? m[1].trim() : ''
}

export function profileFromCard(card: TopCard, profileUrl: string, connection: ConnectionStatus): ProfileData {
  const { firstName, lastName } = splitName(card.name)
  return {
    firstName,
    lastName,
    headline: card.headline,
    company: card.company || companyFromHeadline(card.headline),
    location: card.location,
    profileUrl: normalizeProfileUrl(profileUrl) ?? profileUrl,
    connection,
  }
}

/* ------------------------------------------------------------------ */
/* Message thread (overlay or full page; may live in a shadow root)    */
/* ------------------------------------------------------------------ */

/** An open message window (overlay bubble or full-page thread) that has a visible message box. */
export interface ConversationCandidate {
  /** value of the window's data-la-cand attribute, for bindConversationInPage */
  key: string
  /** the header title (the other person's name) */
  title: string
  /** aria-label of the window, e.g. "Messaging conversation with Jane Doe" */
  label: string
  /** profile links in the window outside its messages and message box (the header) */
  links: string[]
  /** the window has the focus / LinkedIn's active marker */
  active: boolean
  area: number
}

/**
 * Lists the open message windows (each one that holds a visible message box) and marks each with
 * data-la-cand = "<token>:<i>". Which one belongs to the lead is decided by pickConversation.
 */
export function listConversationsInPage(token: string): ConversationCandidate[] {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
  const roots: (Document | ShadowRoot)[] = [document]
  for (let i = 0; i < roots.length; i++) roots[i].querySelectorAll('*').forEach((el) => el.shadowRoot && roots.push(el.shadowRoot))
  const all = (sel: string) => roots.flatMap((r) => Array.from(r.querySelectorAll(sel)))
  all('[data-la-cand]').forEach((e) => (e.getAttribute('data-la-cand') ?? '').startsWith(`${token}:`) && e.removeAttribute('data-la-cand'))

  const vw = window.innerWidth
  const vh = window.innerHeight
  const area = (el: Element) => {
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0 || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return 0
    return r.width * r.height
  }
  const CONTAINER = '.msg-overlay-conversation-bubble, .msg-convo-wrapper, .msg-thread, [role="dialog"]'
  const LIST = '.msg-s-message-list, .msg-s-message-list-content, .msg-s-event-listitem, [data-event-urn], [class*="message-list"]'
  const ITEM = '.msg-s-message-list__event, .msg-s-event-listitem, [data-event-urn]'
  const up = (el: Element): Element | null => el.parentElement ?? ((el.getRootNode() as ShadowRoot).host || null)
  let focused: Element | null = document.activeElement
  while (focused && focused.shadowRoot && focused.shadowRoot.activeElement) focused = focused.shadowRoot.activeElement

  // Only message boxes count (never e.g. a post's comment box that happens to be visible).
  const editors = all('div[contenteditable="true"], div[contenteditable=""], [role="textbox"][contenteditable]').filter(
    (el) =>
      area(el) > 0 &&
      (/msg-form|message/i.test(`${el.className} ${el.getAttribute('aria-label') ?? ''}`) || !!el.closest('.msg-form, .msg-overlay-conversation-bubble, .msg-convo-wrapper, .msg-thread, [role="dialog"]')) &&
      !/comment/i.test(el.getAttribute('aria-label') ?? ''),
  )
  const seen: Element[] = []
  const out: ConversationCandidate[] = []
  for (const ed of editors) {
    // The conversation window: a known container, else the nearest ancestor holding a message list.
    let container: Element | null = null
    let holder: Element | null = null
    for (let el = up(ed), i = 0; el && i < 25; el = up(el), i++) {
      if (el.matches(CONTAINER)) {
        container = el
        break
      }
      if (!holder && el.querySelector(LIST)) holder = el
    }
    container = container ?? holder ?? ed.closest('form')?.parentElement ?? ed.parentElement
    if (!container || seen.includes(container)) continue
    seen.push(container)
    const key = `${token}:${out.length}`
    container.setAttribute('data-la-cand', key)
    const titleEl = container.querySelector('.msg-overlay-bubble-header__title, .msg-entity-lockup__entity-title, .msg-thread__link-to-profile, h2')
    const links = Array.from(container.querySelectorAll('a[href*="/in/"]'))
      .filter((a) => !a.closest(ITEM) && !a.closest('form'))
      .map((a) => (a as HTMLAnchorElement).href)
    out.push({
      key,
      title: clean(titleEl?.textContent),
      label: clean(container.getAttribute('aria-label')),
      links,
      active: /--is-active\b|--active\b/.test(String(container.className)) || (!!focused && container.contains(focused)),
      area: area(container),
    })
  }
  return out
}

/** Marks the candidate `key` as this driver's conversation (data-la-thread = token); '' just unbinds. */
export function bindConversationInPage(args: { token: string; key: string }): boolean {
  const roots: (Document | ShadowRoot)[] = [document]
  for (let i = 0; i < roots.length; i++) roots[i].querySelectorAll('*').forEach((el) => el.shadowRoot && roots.push(el.shadowRoot))
  const all = (sel: string) => roots.flatMap((r) => Array.from(r.querySelectorAll(sel)))
  all(`[data-la-thread="${args.token}"]`).forEach((e) => e.removeAttribute('data-la-thread'))
  if (!args.key) return false
  const el = all(`[data-la-cand="${args.key}"]`)[0]
  if (!el) return false
  el.setAttribute('data-la-thread', args.token)
  return true
}

const fullName = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * The message window that belongs to the lead: its header links to the lead's profile or shows the
 * lead's name. Never another person's window (an incoming chat can pop up at any time). A single
 * window whose header can't be read at all is accepted (everything else was closed before).
 */
export function pickConversation(cands: ConversationCandidate[], lead: { name: string; profileUrl: string }): { key: string | null; other: string } {
  const leadId = lead.profileUrl ? publicIdFromUrl(lead.profileUrl) : null
  const scored = cands.map((c) => {
    const ids = c.links.map((l) => publicIdFromUrl(l)).filter((id): id is string => !!id)
    const name = c.title || (/(?:conversation|chat|messaging) with (.+)$/i.exec(c.label)?.[1] ?? '')
    const score =
      leadId && ids.includes(leadId) ? 3 : lead.name && name && fullName(name) === fullName(lead.name) ? 2 : lead.name && name && sameName(name, lead.name) ? 1 : 0
    return { c, name, score, unreadable: !name && !ids.length }
  })
  const best = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || Number(b.c.active) - Number(a.c.active) || b.c.area - a.c.area)[0]
  if (best) return { key: best.c.key, other: '' }
  if (scored.length === 1 && (scored[0].unreadable || (!lead.name && !leadId))) return { key: scored[0].c.key, other: '' }
  return { key: null, other: scored.find((s) => s.name)?.name ?? '' }
}

export interface ThreadMessage {
  sender: string
  senderHref: string
  /** the item carries LinkedIn's "message from the other person" class */
  other: boolean
  text: string
  /** LinkedIn shows this message as not delivered (error marker / retry button on the message) */
  failed: boolean
}

export interface ThreadSnapshot {
  /** this driver's conversation window (see bindConversationInPage) is open with a message box */
  open: boolean
  title: string
  messages: ThreadMessage[]
  /** InMail / premium composer (subject field, InMail footer): not a 1st-degree conversation */
  inmail: boolean
  composerText: string
  sendFound: boolean
  sendDisabled: boolean
  closeFound: boolean
  /** a send error shown by the window itself (an alert outside the messages; never message text) */
  error: string
  /** LinkedIn is still loading the conversation (a loader / skeleton is visible) */
  loading: boolean
}

/**
 * Reads the conversation window bound to `token` (bindConversationInPage) and nothing else: its
 * messages, and marks its composer, send button and close button with data-la-composer /
 * data-la-send / data-la-close = token. `open: false` when that window is gone.
 */
export function readThreadInPage(token: string): ThreadSnapshot {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
  const none: ThreadSnapshot = {
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
  const roots: (Document | ShadowRoot)[] = [document]
  for (let i = 0; i < roots.length; i++) roots[i].querySelectorAll('*').forEach((el) => el.shadowRoot && roots.push(el.shadowRoot))
  const all = (sel: string) => roots.flatMap((r) => Array.from(r.querySelectorAll(sel)))
  for (const attr of ['data-la-composer', 'data-la-send', 'data-la-close']) all(`[${attr}="${token}"]`).forEach((e) => e.removeAttribute(attr))
  const container = all(`[data-la-thread="${token}"]`)[0]
  if (!container || !container.isConnected) return none

  const vw = window.innerWidth
  const vh = window.innerHeight
  const area = (el: Element) => {
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0 || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return 0
    return r.width * r.height
  }
  const rendered = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
  const editors = Array.from(container.querySelectorAll('div[contenteditable="true"], div[contenteditable=""], [role="textbox"][contenteditable]'))
    .filter((el) => area(el) > 0 && !/comment/i.test(el.getAttribute('aria-label') ?? ''))
    .sort((x, y) => area(y) - area(x))
  if (!editors.length) return none
  const composer = editors[0]
  composer.setAttribute('data-la-composer', token)

  // Text of a message body, keeping emoji drawn as images.
  const textOf = (el: Element | null): string => {
    let out = ''
    const walk = (n: Node) => {
      if (n.nodeType === Node.TEXT_NODE) out += n.textContent ?? ''
      else if (n instanceof HTMLImageElement) out += /\p{Extended_Pictographic}/u.test(n.alt) && n.alt.length <= 8 ? n.alt : ''
      else if (n instanceof HTMLBRElement) out += '\n'
      else n.childNodes.forEach(walk)
    }
    if (el) walk(el)
    return clean(out)
  }
  const label = (b: Element) => clean(b.getAttribute('aria-label')) || clean(b.textContent)
  const FAILED = /(message )?failed to send|couldn[’']t (be )?sen[dt]|message not sent|not delivered|unable to send/i

  // Messages, oldest first. Consecutive messages of one sender share the sender header.
  let items = Array.from(container.querySelectorAll('li.msg-s-message-list__event, .msg-s-message-list__event'))
  if (!items.length) items = Array.from(container.querySelectorAll('.msg-s-event-listitem, [data-event-urn]'))
  const messages: ThreadMessage[] = []
  let sender = ''
  let senderHref = ''
  for (const it of items) {
    const nameEl = it.querySelector('.msg-s-message-group__name, .msg-s-message-group__profile-link, [data-test-message-sender-name]')
    const link = it.querySelector('.msg-s-message-group__meta a[href*="/in/"], a.msg-s-event-listitem__link[href*="/in/"]') as HTMLAnchorElement | null
    if (nameEl) {
      sender = clean(nameEl.textContent)
      senderHref = link?.href ?? ''
    } else if (link) senderHref = link.href
    const body = it.querySelector('.msg-s-event-listitem__body, .msg-s-event__content, [data-test-message-body], p')
    const text = textOf(body)
    const other = it.matches('.msg-s-event-listitem--other') || !!it.querySelector('.msg-s-event-listitem--other')
    // Delivery failure: LinkedIn's marker on this very message (error class, alert, retry button),
    // never words inside a message.
    const failed =
      [it, ...Array.from(it.querySelectorAll('*'))].some((e) => /--(error|failed)(\s|$)/.test(e.getAttribute('class') ?? '') && rendered(e)) ||
      Array.from(it.querySelectorAll('button')).some((b) => rendered(b) && /^(retry|resend|try again)\b/i.test(label(b))) ||
      Array.from(it.querySelectorAll('[role="alert"], [class*="status"], [class*="indicator"], [class*="__error"], [class*="__failed"]')).some(
        (e) => !(body && body.contains(e)) && rendered(e) && FAILED.test(clean(e.textContent)),
      )
    if (!text && !nameEl) continue
    messages.push({ sender, senderHref, other, text, failed })
  }

  const form = composer.closest('form') ?? container
  const send =
    (form.querySelector('button.msg-form__send-button, button.msg-form__send-btn') as HTMLButtonElement | null) ??
    (Array.from(form.querySelectorAll('button')).find((b) => /^send$/i.test(clean(b.textContent)) || /^send\b/i.test(b.getAttribute('aria-label') ?? '')) as
      | HTMLButtonElement
      | undefined) ??
    (form.querySelector('button[type="submit"]') as HTMLButtonElement | null)
  if (send) send.setAttribute('data-la-send', token)
  const close = Array.from(container.querySelectorAll('button')).find((b) =>
    /^close (your )?(draft )?conversation|^close$/i.test(clean(b.getAttribute('aria-label') ?? '') || clean(b.textContent)),
  )
  if (close) close.setAttribute('data-la-close', token)

  // InMail: decided by the message box only (subject field, InMail footer) – never by message history.
  const formOnly = form.cloneNode(true) as Element
  formOnly.querySelectorAll('[contenteditable], textarea').forEach((e) => e.remove())
  const inmail = !!container.querySelector('input[name="subject"], input[placeholder*="subject" i]') || /\binmail\b/i.test(clean(formOnly.textContent))

  // A send error shown by the window (alert / error banner), outside the messages and the box.
  const MESSAGES = '.msg-s-message-list__event, .msg-s-event-listitem, [data-event-urn], .msg-s-message-list-content'
  const alerts = Array.from(container.querySelectorAll('[role="alert"], [class*="error"], .artdeco-inline-feedback'))
    .filter((e) => !e.closest(MESSAGES) && !e.closest('[contenteditable]') && rendered(e))
    .map((e) => clean(e.textContent))
  const loading = Array.from(container.querySelectorAll('.artdeco-loader, .artdeco-spinner, [class*="message-list__loader"], [class*="skeleton"], [aria-busy="true"]')).some(
    (e) => !e.closest('form') && rendered(e),
  )

  return {
    open: true,
    title: clean(container.querySelector('.msg-overlay-bubble-header__title, .msg-entity-lockup__entity-title, h2')?.textContent),
    messages,
    inmail,
    composerText: clean((composer as HTMLElement).innerText ?? composer.textContent),
    sendFound: !!send,
    sendDisabled: !send || send.disabled || send.getAttribute('aria-disabled') === 'true',
    closeFound: !!close,
    error: (FAILED.exec(alerts.join(' | ')) ?? [''])[0],
    loading,
  }
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Compare a message as LinkedIn shows it (editor or thread) with the text we meant to send. */
export function sameMessage(shown: string, wanted: string) {
  const a = norm(shown)
  const b = norm(wanted)
  if (!b) return false
  return a === b || (a.length >= b.length * 0.95 && a.length <= b.length * 1.05 + 5 && a.startsWith(b.slice(0, 40)) && a.endsWith(b.slice(-15)))
}

export interface ReplyContext {
  /** our own name – only when it was read from our LinkedIn profile (not a placeholder) */
  ownName?: string | null
  ownProfileUrl?: string | null
  leadProfileUrl?: string | null
  leadName?: string | null
}

/** 'unknown' messages are never counted as the lead's. */
export type Author = 'me' | 'lead' | 'unknown'

/**
 * Who wrote each message: LinkedIn's own "--other" marker first, then the sender's profile link,
 * then names. A sender that matches neither side stays 'unknown' (never assumed to be the lead).
 */
export function authorsOf(thread: ThreadSnapshot, who: ReplyContext): Author[] {
  const ownId = who.ownProfileUrl ? publicIdFromUrl(who.ownProfileUrl) : null
  const leadId = who.leadProfileUrl ? publicIdFromUrl(who.leadProfileUrl) : null
  // Once the thread uses LinkedIn's marker for the other person, the unmarked messages are ours.
  const markers = thread.messages.some((m) => m.other)
  return thread.messages.map((m): Author => {
    if (m.other) return 'lead'
    const id = m.senderHref ? publicIdFromUrl(m.senderHref) : null
    if (id && leadId && id === leadId) return 'lead'
    if (id && ownId && id === ownId) return 'me'
    if (markers) return 'me'
    const name = normalizeName(m.sender)
    if (!name) return 'unknown'
    if (name === 'you') return 'me'
    const isLead = !!who.leadName && sameName(m.sender, who.leadName)
    const isOwn = !!who.ownName && sameName(m.sender, who.ownName)
    if (isLead !== isOwn) return isLead ? 'lead' : 'me'
    return 'unknown'
  })
}

/**
 * Whether the lead wrote after our message with the text `after` (the last message this campaign
 * sent); when `after` is null or not in the loaded history, after our latest own message.
 */
export function hasReplyAfter(thread: ThreadSnapshot, who: ReplyContext, after: string | null): boolean {
  const authors = authorsOf(thread, who)
  const msgs = thread.messages
  let anchor = -1
  if (after && norm(after)) {
    for (let i = msgs.length - 1; i >= 0 && anchor < 0; i--) if (authors[i] !== 'lead' && sameMessage(msgs[i].text, after)) anchor = i
  }
  if (anchor < 0) for (let i = msgs.length - 1; i >= 0 && anchor < 0; i--) if (authors[i] !== 'lead') anchor = i
  return authors.some((a, i) => a === 'lead' && i > anchor)
}

/** Our most recent message in the thread (anything not written by the lead), or null. */
export function lastOwnMessage(thread: ThreadSnapshot, who: ReplyContext): ThreadMessage | null {
  const authors = authorsOf(thread, who)
  for (let i = thread.messages.length - 1; i >= 0; i--) if (authors[i] !== 'lead') return thread.messages[i]
  return null
}

/**
 * Our most recent message is `text` and was delivered: an earlier attempt already sent it (even
 * if the lead has answered it since), so sending again would be a duplicate.
 */
export function alreadySent(thread: ThreadSnapshot, who: ReplyContext, text: string): boolean {
  const mine = lastOwnMessage(thread, who)
  return !!mine && !mine.failed && sameMessage(mine.text, text)
}

/* ------------------------------------------------------------------ */
/* Invitation dialogs                                                  */
/* ------------------------------------------------------------------ */

export interface DialogInfo {
  text: string
  buttons: string[]
  textarea: boolean
  maxLength: number | null
  emailInput: boolean
}

export interface InviteUi {
  dialogs: DialogInfo[]
  toasts: string[]
}

/**
 * Dialogs and toasts of the page. Messaging windows (chat bubbles also use role="dialog") are never
 * dialogs here. With a token, the dialog that classifyInviteUi looks at (the last one) is marked
 * with data-la-dialog = token, so the driver clicks in exactly that dialog.
 */
export function readInviteUiInPage(token = ''): InviteUi {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
  const roots: (Document | ShadowRoot)[] = [document]
  for (let i = 0; i < roots.length; i++) roots[i].querySelectorAll('*').forEach((el) => el.shadowRoot && roots.push(el.shadowRoot))
  const all = (sel: string) => roots.flatMap((r) => Array.from(r.querySelectorAll(sel)))
  const rendered = (el: Element) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'
  }
  const MESSAGING = '.msg-overlay-container, .msg-overlay-conversation-bubble, .msg-overlay-list-bubble, .msg-convo-wrapper, .msg-thread, .msg-form'
  const messaging = (el: Element) => !!el.closest(MESSAGING) || !!el.querySelector('.msg-form, .msg-s-message-list, .msg-s-message-list-content, .msg-form__contenteditable')
  const found = all('[role="dialog"], [role="alertdialog"], .artdeco-modal').filter((d) => rendered(d) && !messaging(d))
  const outer = found.filter((d) => !found.some((o) => o !== d && o.contains(d)))
  if (token) {
    all(`[data-la-dialog="${token}"]`).forEach((e) => e.removeAttribute('data-la-dialog'))
    outer[outer.length - 1]?.setAttribute('data-la-dialog', token)
  }
  const dialogs = outer.map((d) => {
    const ta = d.querySelector('textarea') as HTMLTextAreaElement | null
    return {
      text: clean((d as HTMLElement).innerText ?? d.textContent).slice(0, 800),
      buttons: Array.from(d.querySelectorAll('button')).map((b) => clean(b.getAttribute('aria-label')) || clean(b.textContent)),
      textarea: !!ta && rendered(ta),
      maxLength: ta && ta.maxLength > 0 ? ta.maxLength : null,
      emailInput: !!d.querySelector('input[type="email"], input[name="email"], input#email'),
    }
  })
  const toasts = all('.artdeco-toast-item, [data-test-artdeco-toast-item-type], .artdeco-toasts_toasts li, [role="alert"]')
    .filter((t) => rendered(t) && !t.closest(MESSAGING))
    .map((t) => clean(t.textContent))
    .filter(Boolean)
  return { dialogs, toasts }
}

export type InviteStep = 'limit' | 'email' | 'note' | 'choose' | 'upsell' | 'other' | 'sent' | 'failed' | 'none'

const LIMIT_RE = /weekly invitation limit|invitation limit|reached the (weekly )?limit|out of invitations|too many (pending )?invitations|no more invitations/i
const EMAIL_RE = /enter (their|the member[’']s|his|her) email|email address to connect|knows you,? please enter|to verify this member knows you/i
const UPSELL_RE = /premium/i
const INVITE_FAILED_RE =
  /\bnot (been )?sent|couldn[’']t (be )?(send|sent|connect)|could not (be )?(send|sent|connect)|unable to (send|connect)|failed|resend .* after|try again later/i
export const BTN = {
  addNote: /^add (a )?(free )?note\b/i,
  sendWithout: /^send without( a)? note$/i,
  send: /^send( now| invitation| invite)?$/i,
  dismiss: /^(dismiss|close|got it|not now|no,? thanks|maybe later|cancel)\b/i,
  withdraw: /^withdraw( invitation)?$/i,
}

/** What the invitation flow is showing right now. */
export function classifyInviteUi(ui: InviteUi): { step: InviteStep; text: string; dialog: DialogInfo | null } {
  const d = ui.dialogs[ui.dialogs.length - 1] ?? null
  if (d) {
    const r = (step: InviteStep) => ({ step, text: d.text, dialog: d })
    if (LIMIT_RE.test(d.text)) return r('limit')
    if (d.emailInput || EMAIL_RE.test(d.text)) return r('email')
    if (d.textarea) return r('note')
    if (d.buttons.some((b) => BTN.addNote.test(b) || BTN.sendWithout.test(b) || BTN.send.test(b))) return r('choose')
    if (UPSELL_RE.test(d.text)) return r('upsell')
    return r('other')
  }
  const toast = ui.toasts.join(' | ')
  if (LIMIT_RE.test(toast)) return { step: 'limit', text: toast, dialog: null }
  // Failure first: "Your invitation to Jane was not sent" also contains "invitation to … sent".
  if (INVITE_FAILED_RE.test(toast)) return { step: 'failed', text: toast, dialog: null }
  if (/invitation (was )?sent|invitation to .+ (was )?sent|sent (an |your )?invitation/i.test(toast)) return { step: 'sent', text: toast, dialog: null }
  return { step: 'none', text: toast, dialog: null }
}

/* ------------------------------------------------------------------ */
/* People search                                                       */
/* ------------------------------------------------------------------ */

export interface SearchRow {
  href: string
  name: string
  headline: string
  location: string
}

export interface SearchSnapshot {
  rows: SearchRow[]
  noResults: boolean
  next: 'enabled' | 'disabled' | 'missing'
  limitReached: boolean
}

export function readSearchInPage(): SearchSnapshot {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
  const HIDDEN = '.visually-hidden, .sr-only, .a11y-text, script, style, template, [hidden], svg'
  const visibleText = (el: Element | null): string => {
    if (!el) return ''
    let out = ''
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement
      if (p && p.closest(HIDDEN)) continue
      out += ' ' + (n.textContent ?? '')
    }
    return clean(out)
  }
  const main = document.querySelector('main') ?? document.body
  const PROFILE = /linkedin\.com\/in\/[^/?#]+/i
  const ITEM = 'li, [data-chameleon-result-urn], [data-view-name*="search-entity-result"], [data-view-name="people-search-result"], .entity-result, .reusable-search__result-container'
  const profileLinks = (el: Element) => Array.from(el.querySelectorAll('a[href*="/in/"]')).filter((a) => PROFILE.test((a as HTMLAnchorElement).href)) as HTMLAnchorElement[]

  const items: Element[] = []
  for (const a of profileLinks(main)) {
    const it = a.closest(ITEM)
    if (it && !items.includes(it)) items.push(it)
  }
  // A result's first profile link is its own; a wrapper's first link sits inside a nested item.
  const isResult = (it: Element) => {
    const first = profileLinks(it)[0]
    return !items.some((n) => n !== it && it.contains(n) && first && n.contains(first))
  }
  const results = items.filter((it) => isResult(it) && !items.some((o) => o !== it && o.contains(it) && isResult(o)))

  const NOISE = /^([·•|]|(?:[·•]\s*)?(1st|2nd|3rd\+?)( degree( connection)?)?|status is \w+|view .+profile|premium|verified|(he|she|they)\s*\/\s*\w+)$/i
  const INSIGHT = /mutual connection|followers?$|^(current|past|summary|skills):|shared connection|connections? in common/i
  const rows: SearchRow[] = []
  for (const it of results) {
    const links = profileLinks(it)
    const href = links[0].href
    const id = (/\/in\/([^/?#]+)/i.exec(href) ?? [])[1]
    const titled = links.filter((a) => (/\/in\/([^/?#]+)/i.exec(a.href) ?? [])[1] === id)
    const nameLink = titled.find((a) => visibleText(a.querySelector('span[aria-hidden="true"]') ?? a)) ?? titled[0]
    const name = visibleText(nameLink.querySelector('span[aria-hidden="true"]') ?? nameLink)
    let headline = visibleText(it.querySelector('.entity-result__primary-subtitle'))
    let loc = visibleText(it.querySelector('.entity-result__secondary-subtitle'))
    if (!headline || !loc) {
      // Fallback: the text runs after the name, skipping degree badges and insights.
      const runs: { el: Element; text: string }[] = []
      const walker = document.createTreeWalker(it, NodeFilter.SHOW_TEXT)
      let last: Element | null = null
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const p = n.parentElement
        const t = clean(n.textContent)
        if (!p || !t || p.closest(HIDDEN) || p.closest('button, [role="button"]')) continue
        if (p === last) runs[runs.length - 1].text += ' ' + t
        else runs.push({ el: p, text: t })
        last = p
      }
      const start = runs.findIndex((r) => nameLink.contains(r.el))
      const rest = runs
        .slice(start + 1)
        .filter((r) => !nameLink.contains(r.el) && !NOISE.test(r.text) && r.text !== name && r.text.length > 1)
        .map((r) => r.text)
      if (!headline && rest[0] && !INSIGHT.test(rest[0])) headline = rest[0]
      if (!loc && rest[1] && !INSIGHT.test(rest[1])) loc = rest[1]
    }
    rows.push({ href, name, headline, location: loc })
  }

  const nextBtn = Array.from(main.querySelectorAll('button, a')).find(
    (b) => /^next$/i.test(clean(b.getAttribute('aria-label'))) || /^next$/i.test(visibleText(b)) || /pagination.*next|next.*pagination/i.test(b.getAttribute('data-testid') ?? ''),
  )
  const heads = Array.from(main.querySelectorAll('h1, h2, h3')).map((h) => clean(h.textContent)).join(' | ')
  // The monthly limit is LinkedIn's banner, never words in a result (headline, insight): result
  // rows are left out.
  const LIMIT = /commercial use limit|reached the monthly limit|monthly limit for (profile )?search/i
  const banners = Array.from(
    main.querySelectorAll('[class*="paywall"], [class*="upsell"], [class*="search-limit"], [class*="no-results"], [class*="empty-state"], [role="alert"]'),
  ).map((e) => clean(e.textContent))
  let rest = ''
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n && rest.length < 8000; n = walker.nextNode()) {
    const p = n.parentElement
    if (!p || p.closest('script, style, template') || items.some((it) => it.contains(p))) continue
    rest += ' ' + (n.textContent ?? '')
  }
  return {
    rows,
    noResults: /no results found|no results for|try (removing|shortening)|we couldn[’']t find/i.test(heads) || !!main.querySelector('.search-reusable-search-no-results'),
    next: !nextBtn ? 'missing' : nextBtn.hasAttribute('disabled') || nextBtn.getAttribute('aria-disabled') === 'true' ? 'disabled' : 'enabled',
    limitReached: LIMIT.test(banners.join(' | ')) || LIMIT.test(clean(rest)),
  }
}

export const PAGE_SIZE = 10

/** Turn raw rows into SearchPage people (canonical URLs, split names, no duplicates). */
export function parseSearch(snap: SearchSnapshot): SearchPage {
  const people: SearchPerson[] = []
  const seen = new Set<string>()
  for (const r of snap.rows) {
    const url = normalizeProfileUrl(r.href)
    const id = url ? publicIdFromUrl(url) : null
    if (!url || !id || seen.has(url)) continue
    if (!r.name || /^linkedin member$/i.test(r.name)) continue
    seen.add(url)
    const { firstName, lastName } = splitName(r.name)
    people.push({ profileUrl: url, firstName, lastName, headline: r.headline, location: r.location })
  }
  const hasMore = snap.next === 'enabled' ? true : snap.next === 'disabled' ? false : snap.rows.length >= PAGE_SIZE
  return { people, hasMore: hasMore && !snap.noResults }
}

/* ------------------------------------------------------------------ */
/* Recent activity (latest post)                                       */
/* ------------------------------------------------------------------ */

export interface PostsSnapshot {
  posts: number
  empty: boolean
  like: 'pressed' | 'unpressed' | 'missing'
}

/** Finds the first post on a recent-activity page and marks its Like button with data-la-like = token. */
export function readPostsInPage(token: string): PostsSnapshot {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
  const main = document.querySelector('main') ?? document.body
  document.querySelectorAll('[data-la-like]').forEach((e) => e.removeAttribute('data-la-like'))
  const found = Array.from(
    main.querySelectorAll('[data-urn^="urn:li:activity:"], [data-id^="urn:li:activity:"], div.feed-shared-update-v2, [data-view-name="feed-full-update"]'),
  ).filter((el) => el.getClientRects().length > 0)
  const posts = found.filter((el) => !found.some((o) => o !== el && o.contains(el)))
  const empty = /hasn[’']t posted|no (recent )?(posts|activity)|nothing to see|hasn[’']t (shared|been active)|no posts yet/i.test(clean((main as HTMLElement).innerText ?? ''))
  if (!posts.length) return { posts: 0, empty, like: 'missing' }
  const label = (b: Element) => clean(b.getAttribute('aria-label')) || clean(b.textContent)
  const btn = Array.from(posts[0].querySelectorAll('button')).find(
    (b) => b.classList.contains('react-button__trigger') || /^(react )?like\b|^unreact\b|^(remove|undo) (your )?.*reaction/i.test(label(b)),
  )
  if (!btn) return { posts: posts.length, empty, like: 'missing' }
  btn.setAttribute('data-la-like', token)
  const pressed = btn.getAttribute('aria-pressed') === 'true' || /^unreact\b|^(remove|undo) (your )?.*reaction/i.test(label(btn))
  return { posts: posts.length, empty, like: pressed ? 'pressed' : 'unpressed' }
}
