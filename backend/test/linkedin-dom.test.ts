import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import type { Page } from 'playwright'
import {
  ACTION,
  alreadySent,
  authorsOf,
  bindConversationInPage,
  classifyConnection,
  classifyInviteUi,
  classifyPage,
  companyFromHeadline,
  type ConversationCandidate,
  hasAction,
  hasReplyAfter,
  isAuthUrl,
  listConversationsInPage,
  type PageState,
  pageStateInPage,
  parseSearch,
  pickConversation,
  profileFromCard,
  readInviteUiInPage,
  readPostsInPage,
  readSearchInPage,
  readThreadInPage,
  readTopCardInPage,
  type ThreadMessage,
  type ThreadSnapshot,
} from '../src/linkedin/playwright/dom.ts'
import { fitNote, sameMessage } from '../src/linkedin/playwright/driver.ts'
import { closeBrowser, closePage, fixture, linkedInPage, pageWith } from './helpers/linkedin-browser.ts'

after(closeBrowser)

async function card(name: string) {
  const page = await pageWith(fixture(name))
  try {
    return await page.evaluate(readTopCardInPage)
  } finally {
    await closePage(page)
  }
}

describe('profile top card', () => {
  it('parses a 2nd-degree profile and ignores "People also viewed"', async () => {
    const c = await card('profile-2nd.html')
    assert.equal(c.found, true)
    assert.equal(c.name, 'Jane Doe')
    assert.equal(c.headline, 'Head of Growth at Acme Corp | B2B SaaS | Speaker')
    assert.equal(c.location, 'San Francisco Bay Area')
    assert.equal(c.company, 'Acme Corp')
    assert.equal(c.degree, '2nd')
    assert.match(c.imageUrl ?? '', /profile-displayphoto-shrink_200_200/)
    assert.equal(classifyConnection(c), 'not_connected')
    assert.ok(hasAction(c, ACTION.connect))
    assert.ok(hasAction(c, ACTION.message))
    assert.ok(hasAction(c, ACTION.more))
    assert.ok(c.actions.some((a) => a.inMenu && ACTION.follow(a)), 'the hidden More menu is read too')
    assert.ok(!c.actions.some((a) => /Bob Smith/.test(a.label)), 'aside actions are not part of the top card')
    assert.deepEqual(profileFromCard(c, 'https://linkedin.com/in/Jane-Doe-1a2b3c?x=1', 'not_connected'), {
      firstName: 'Jane',
      lastName: 'Doe',
      headline: 'Head of Growth at Acme Corp | B2B SaaS | Speaker',
      company: 'Acme Corp',
      location: 'San Francisco Bay Area',
      profileUrl: 'https://www.linkedin.com/in/jane-doe-1a2b3c/',
      connection: 'not_connected',
    })
  })

  it('detects 1st-degree connections', async () => {
    const c = await card('profile-1st.html')
    assert.equal(c.degree, '1st')
    assert.equal(classifyConnection(c), 'connected')
    assert.ok(hasAction(c, ACTION.remove))
    assert.ok(hasAction(c, ACTION.following))
    assert.ok(!hasAction(c, ACTION.connect))
  })

  it('detects a pending invitation', async () => {
    const c = await card('profile-pending.html')
    assert.equal(classifyConnection(c), 'pending')
  })

  it('finds Connect inside the More menu (Follow-first profiles)', async () => {
    const c = await card('profile-connect-in-more.html')
    assert.equal(c.degree, '3rd+')
    assert.equal(classifyConnection(c), 'not_connected')
    const connect = c.actions.find(ACTION.connect)
    assert.ok(connect?.inMenu)
    assert.ok(c.actions.some((a) => !a.inMenu && ACTION.follow(a)))
  })

  it('falls back to structure when class names are obfuscated', async () => {
    const c = await card('profile-obfuscated.html')
    assert.equal(c.name, 'Rahul Mehta')
    assert.equal(c.headline, 'Founder at Northwind · Ex-Google · Angel investor')
    assert.equal(c.location, 'Mumbai, Maharashtra, India')
    assert.equal(c.degree, '1st')
    assert.equal(classifyConnection(c), 'connected')
    assert.match(c.imageUrl ?? '', /profile-displayphoto-shrink_400_400/)
    assert.ok(!c.actions.some((a) => /Northwind/.test(a.label)), 'buttons of other sections are ignored')
    const p = profileFromCard(c, 'https://www.linkedin.com/in/rahul-mehta/', 'connected')
    assert.equal(p.company, 'Northwind')
  })

  it('reports unknown when nothing tells the connection state', () => {
    const base = { url: 'https://www.linkedin.com/in/x/', found: true, name: 'X', headline: '', location: '', company: '', degree: null, imageUrl: null }
    assert.equal(classifyConnection({ ...base, actions: [{ label: 'Message Jane', text: 'Message', href: '', inMenu: false, disabled: false }] }), 'unknown')
    assert.equal(classifyConnection({ ...base, actions: [{ label: 'Accept Jane’s invitation', text: 'Accept', href: '', inMenu: false, disabled: false }] }), 'not_connected')
  })

  it('pulls the company out of headlines', () => {
    assert.equal(companyFromHeadline('VP Sales at Globex | Ex-Initech'), 'Globex')
    assert.equal(companyFromHeadline('Engineer @ Hooli, ML'), 'Hooli')
    assert.equal(companyFromHeadline('Independent consultant'), '')
  })
})

describe('page state', () => {
  it('flags login URLs, authwalls, 404 pages and logged-in pages', async () => {
    assert.ok(isAuthUrl('https://www.linkedin.com/login?session_redirect=x'))
    assert.ok(isAuthUrl('https://www.linkedin.com/checkpoint/challenge/AgH'))
    assert.ok(isAuthUrl('https://www.linkedin.com/authwall?trk=1'))
    assert.ok(isAuthUrl('https://www.linkedin.com/uas/login'))
    assert.ok(!isAuthUrl('https://www.linkedin.com/in/jane/'))
    assert.ok(!isAuthUrl('https://example.com/login'))

    for (const [name, verdict] of [
      ['authwall.html', 'session_expired'],
      ['page-not-found.html', 'not_found'],
      ['profile-2nd.html', 'ok'],
      ['feed.html', 'ok'],
    ] as const) {
      const page = await pageWith(fixture(name))
      const state = await page.evaluate(pageStateInPage)
      assert.equal(classifyPage({ ...state, url: 'https://www.linkedin.com/in/x/' }), verdict, name)
      await closePage(page)
    }
    const base: PageState = { url: 'https://www.linkedin.com/in/x/', loggedIn: true, authwall: false, notFound: false, rateLimited: false, searchLimit: false, lang: 'en' }
    assert.equal(classifyPage({ ...base, url: 'https://www.linkedin.com/login' }), 'session_expired')
    assert.equal(classifyPage({ ...base, rateLimited: true }), 'rate_limited')
    assert.equal(classifyPage({ ...base, searchLimit: true }), 'search_limit')
    assert.equal(classifyPage({ ...base, lang: 'de' }), 'not_english')
    assert.equal(classifyPage({ ...base, lang: 'pt_BR' }), 'not_english')
    for (const lang of ['', 'en', 'en-US', 'en_GB']) assert.equal(classifyPage({ ...base, lang }), 'ok', lang)
  })

  /** pageStateInPage for `html` served at a linkedin.com `path`. */
  async function stateAt(path: string, html: string) {
    const page = await linkedInPage(() => html)
    try {
      await page.goto(`https://www.linkedin.com${path}`)
      return await page.evaluate(pageStateInPage)
    } finally {
      await closePage(page)
    }
  }

  it('reads limits and errors from LinkedIn’s own headings and banners, never from profile or post text', async () => {
    const about = `<section class="artdeco-card"><h2>About</h2><h3>Too many requests? Page not found?</h3>
      <p>I help SDRs prospect without hitting LinkedIn's commercial use limit. You've made too many excuses.</p></section>`
    const profile = fixture('profile-2nd.html').replace('</main>', `${about}</main>`)
    const s = await stateAt('/in/jane-doe/', profile)
    assert.deepEqual([s.notFound, s.rateLimited, s.searchLimit, s.lang], [false, false, false, 'en'])
    assert.equal(classifyPage(s), 'ok')

    const results = fixture('search-results.html')
    assert.equal((await stateAt('/search/results/people/', results.replace('VP Marketing at Globex', 'VP Marketing | beating the commercial use limit'))).searchLimit, false)
    const banner = '<div class="search-paywall__info"><h2>You’ve reached the monthly limit for profile searches</h2></div>'
    assert.equal((await stateAt('/search/results/people/', results.replace('<div class="search-results-container">', `<div class="search-results-container">${banner}`))).searchLimit, true)
    assert.equal((await stateAt('/in/jane/', profile.replace('</main>', `${banner}</main>`))).searchLimit, false, 'only on search pages')

    assert.equal((await stateAt('/in/x/', '<html><body><h1>Too many requests</h1></body></html>')).rateLimited, true)
    assert.equal((await stateAt('/in/x/', '<html><body>Too many requests</body></html>')).rateLimited, true)
    assert.equal((await stateAt('/in/x/', fixture('page-not-found.html'))).notFound, true)
    assert.equal((await stateAt('/in/x/', fixture('profile-2nd.html').replace('<html lang="en">', '<html lang="de-DE">'))).lang, 'de-DE')
  })
})

describe('search results', () => {
  it('parses classic results, skipping mutual-connection links and hidden members; keeps member-id links case-sensitive', async () => {
    const page = await pageWith(fixture('search-results.html'))
    const snap = await page.evaluate(readSearchInPage)
    await closePage(page)
    assert.equal(snap.next, 'enabled')
    assert.equal(snap.rows.length, 8, 'one row per result (the LinkedIn Member has no profile link)')
    const res = parseSearch(snap)
    assert.equal(res.hasMore, true)
    assert.equal(res.people.length, 8)
    assert.deepEqual(res.people[0], {
      profileUrl: 'https://www.linkedin.com/in/priya-sharma-42/',
      firstName: 'Priya',
      lastName: 'Sharma',
      headline: 'VP Marketing at Globex',
      location: 'Bengaluru, Karnataka, India',
    })
    assert.deepEqual(
      res.people.map((p) => `${p.firstName} ${p.lastName}`),
      ['Priya Sharma', 'Liam O’Brien', 'Sofia García', 'Noah Kim', 'Mia Rossi', 'Arjun Iyer', 'Emma Brown', 'Hidden Urn'],
    )
    const urn = res.people.find((p) => p.firstName === 'Hidden')
    assert.equal(urn?.profileUrl, 'https://www.linkedin.com/in/ACoAABcdEFgh123IjKlMnOpQrStUvWx/')
    assert.equal(res.people[1].headline, 'Founder & CEO at Pied Piper')
    assert.ok(!res.people.some((p) => /mutual-friend/.test(p.profileUrl)))
  })

  it('parses obfuscated results by structure; no pagination and < 10 rows means no more pages', async () => {
    const page = await pageWith(fixture('search-obfuscated.html'))
    const snap = await page.evaluate(readSearchInPage)
    await closePage(page)
    const res = parseSearch(snap)
    assert.equal(snap.next, 'missing')
    assert.equal(res.hasMore, false)
    assert.deepEqual(res.people, [
      { profileUrl: 'https://www.linkedin.com/in/olivia-chen-a1/', firstName: 'Olivia', lastName: 'Chen', headline: 'Engineering Manager · Hooli', location: 'Toronto, Ontario, Canada' },
      { profileUrl: 'https://www.linkedin.com/in/m%C3%BCller-hans/', firstName: 'Hans', lastName: 'Müller', headline: 'Operations Lead at Stark Industries', location: 'Berlin, Germany' },
      { profileUrl: 'https://www.linkedin.com/in/zara-das/', firstName: 'Zara', lastName: 'Das', headline: 'Talent Acquisition Lead', location: '' },
    ])
  })

  it('the monthly limit is LinkedIn’s banner, not a result headline that mentions it', async () => {
    const html = fixture('search-results.html')
    const read = async (h: string) => {
      const page = await pageWith(h)
      try {
        return await page.evaluate(readSearchInPage)
      } finally {
        await closePage(page)
      }
    }
    const headline = await read(html.replace('VP Marketing at Globex', 'VP Marketing at Globex | Beat the commercial use limit'))
    assert.equal(headline.limitReached, false)
    assert.equal(headline.rows.length, 8)
    const banner = await read(html.replace('<div class="search-results-container">', '<div class="search-results-container"><div class="search-paywall__info"><h2>You’ve reached the monthly limit for profile searches</h2></div>'))
    assert.equal(banner.limitReached, true)
  })

  it('hasMore follows the Next button, else a full page', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ href: `https://www.linkedin.com/in/p${i}/`, name: `P ${i}`, headline: '', location: '' }))
    assert.equal(parseSearch({ rows, noResults: false, next: 'missing', limitReached: false }).hasMore, true)
    assert.equal(parseSearch({ rows, noResults: false, next: 'disabled', limitReached: false }).hasMore, false)
    assert.equal(parseSearch({ rows: [], noResults: true, next: 'missing', limitReached: false }).hasMore, false)
  })
})

const own = (text: string, meta = true) => `
  <li class="msg-s-message-list__event clearfix">
    <div class="msg-s-event-listitem">
      ${meta ? `<a class="msg-s-event-listitem__link" href="https://www.linkedin.com/in/sam-sender/"><img alt="Sam Sender"></a>
      <div class="msg-s-message-group__meta"><span class="msg-s-message-group__name">Sam Sender</span><time class="msg-s-message-group__timestamp">10:02 AM</time></div>` : ''}
      <div class="msg-s-event-listitem__message-bubble"><p class="msg-s-event-listitem__body">${text}</p></div>
    </div>
  </li>`
const theirs = (text: string) => `
  <li class="msg-s-message-list__event clearfix">
    <div class="msg-s-event-listitem msg-s-event-listitem--other">
      <a class="msg-s-event-listitem__link" href="https://www.linkedin.com/in/jane-doe-1a2b3c/"><img alt="Jane Doe"></a>
      <div class="msg-s-message-group__meta"><span class="msg-s-message-group__name">Jane Doe</span></div>
      <div class="msg-s-event-listitem__message-bubble"><p class="msg-s-event-listitem__body">${text}</p></div>
    </div>
  </li>`
const named = (who: string, text: string) => `
  <li class="msg-s-message-list__event"><div class="msg-s-event-listitem">
    <div class="msg-s-message-group__meta"><span class="msg-s-message-group__name">${who}</span></div>
    <p class="msg-s-event-listitem__body">${text}</p></div></li>`
const failedOwn = (text: string) => `
  <li class="msg-s-message-list__event clearfix">
    <div class="msg-s-event-listitem msg-s-event-listitem--error">
      <div class="msg-s-message-group__meta"><span class="msg-s-message-group__name">Sam Sender</span></div>
      <p class="msg-s-event-listitem__body">${text}</p>
      <div class="msg-s-event-listitem__error"><span role="alert">Failed to send</span><button type="button" aria-label="Retry sending message">Retry</button></div>
    </div>
  </li>`
/** Another person's conversation window (same size as Jane's), placed before hers. */
const bobBubble = `
  <div class="msg-overlay-conversation-bubble" role="dialog" aria-label="Messaging conversation with Bob Smith" style="width: 400px; height: 480px; display: flex; flex-direction: column; background: #fff;">
    <header class="msg-overlay-bubble-header"><h2 class="msg-overlay-bubble-header__title"><a href="/in/bob-smith-77/"><span>Bob Smith</span></a></h2>
      <button type="button"><span>Close your conversation with Bob Smith</span></button></header>
    <div class="msg-s-message-list-container" style="flex: 1"><ul class="msg-s-message-list-content">${theirs('Hey Sam!')}</ul></div>
    <form class="msg-form"><div class="msg-form__contenteditable" contenteditable="true" role="textbox" aria-label="Write a message…" style="min-height: 80px;"><p>Draft for Bob</p></div>
      <button class="msg-form__send-button" type="submit">Send</button></form>
  </div>`

const JANE = { name: 'Jane Doe', profileUrl: 'https://www.linkedin.com/in/jane-doe-1a2b3c/' }

async function overlayPage(vars: { MESSAGES?: string; BEFORE?: string; LIST_EXTRA?: string; FORM_EXTRA?: string }) {
  return pageWith(fixture('messaging-overlay.html', { MESSAGES: '', BEFORE: '', LIST_EXTRA: '', FORM_EXTRA: '', ...vars }))
}

/** List the conversation windows, bind the lead's (as the driver does) and read it. */
async function bindAndRead(page: Page, lead = JANE) {
  const cands = await page.evaluate(listConversationsInPage, 'tok')
  const { key } = pickConversation(cands, lead)
  assert.ok(key, 'the lead’s window is found')
  assert.equal(await page.evaluate(bindConversationInPage, { token: 'tok', key }), true)
  return page.evaluate(readThreadInPage, 'tok')
}

async function thread(messages: string, extra: { BEFORE?: string; LIST_EXTRA?: string; FORM_EXTRA?: string } = {}): Promise<ThreadSnapshot> {
  const page = await overlayPage({ MESSAGES: messages, ...extra })
  try {
    return await bindAndRead(page)
  } finally {
    await closePage(page)
  }
}

describe('message thread', () => {
  const who = { ownName: 'Sam Sender', ownProfileUrl: 'https://www.linkedin.com/in/sam-sender/', leadProfileUrl: 'https://www.linkedin.com/in/jane-doe-1a2b3c/', leadName: 'Jane Doe' }

  it('reads the conversation in the shadow-DOM overlay (not the off-screen messaging bar)', async () => {
    const t = await thread(own('Hi Jane, thanks for connecting!') + theirs('Hey Sam! Happy to chat.'))
    assert.equal(t.open, true)
    assert.equal(t.title, 'Jane Doe')
    assert.equal(t.composerText, '', 'the active composer, not the stale draft')
    assert.equal(t.sendFound, true)
    assert.equal(t.sendDisabled, true)
    assert.equal(t.closeFound, true)
    assert.equal(t.inmail, false)
    assert.equal(t.loading, false)
    assert.deepEqual(
      t.messages.map((m) => [m.sender, m.other, m.text, m.failed]),
      [
        ['Sam Sender', false, 'Hi Jane, thanks for connecting!', false],
        ['Jane Doe', true, 'Hey Sam! Happy to chat.', false],
      ],
    )
    assert.equal(hasReplyAfter(t, who, 'Hi Jane, thanks for connecting!'), true)
  })

  it('binds the lead’s window and reads only it, whatever other window is open', async () => {
    const page = await overlayPage({ MESSAGES: own('Hi Jane'), BEFORE: bobBubble })
    try {
      const cands = await page.evaluate(listConversationsInPage, 'tok')
      assert.deepEqual(
        cands.map((c) => c.title),
        ['Bob Smith', 'Jane Doe'],
      )
      const t = await bindAndRead(page)
      assert.equal(t.title, 'Jane Doe')
      assert.deepEqual(t.messages.map((m) => m.text), ['Hi Jane'])
      assert.equal(t.composerText, '', 'not Bob’s draft')
      // The marks sit inside Jane's window.
      const marked = await page.evaluate(() => {
        const root = document.getElementById('interop-outlet')!.shadowRoot!
        return ['composer', 'send', 'close'].map((k) => root.querySelector(`[data-la-${k}="tok"]`)?.closest('[role="dialog"]')?.getAttribute('aria-label'))
      })
      assert.deepEqual(marked, Array(3).fill('Messaging conversation with Jane Doe'))
      // Once Jane's window is gone, nothing else is read in its place.
      await page.evaluate(() => document.getElementById('interop-outlet')!.shadowRoot!.querySelector('[aria-label="Messaging conversation with Jane Doe"]')!.remove())
      assert.equal((await page.evaluate(readThreadInPage, 'tok')).open, false)
      const left = await page.evaluate(listConversationsInPage, 'tok')
      assert.deepEqual(pickConversation(left, JANE), { key: null, other: 'Bob Smith' })
    } finally {
      await closePage(page)
    }
  })

  it('picks the lead’s window by profile link or name, never someone else’s', () => {
    const c = (title: string, links: string[] = [], extra: Partial<ConversationCandidate> = {}): ConversationCandidate => ({
      key: title || 'blank',
      title,
      label: '',
      links,
      active: false,
      area: 100,
      ...extra,
    })
    assert.equal(pickConversation([c('Bob Smith'), c('Jane Doe')], JANE).key, 'Jane Doe')
    assert.equal(pickConversation([c('Bob Smith'), c('J. Doe', ['https://www.linkedin.com/in/jane-doe-1a2b3c/'])], JANE).key, 'J. Doe')
    assert.equal(pickConversation([c('Jane Doe, Bob Smith'), c('Jane Doe')], JANE).key, 'Jane Doe', 'the exact name wins')
    assert.equal(pickConversation([c('', [], { label: 'Messaging conversation with Jane Doe' })], JANE).key, 'blank')
    assert.equal(pickConversation([c('Bob Smith')], JANE).key, null)
    assert.equal(pickConversation([c('')], JANE).key, 'blank', 'a single unreadable window')
    assert.equal(pickConversation([c(''), c('Bob Smith')], JANE).key, null)
  })

  it('no reply when only we wrote (grouped messages inherit the sender)', async () => {
    const t = await thread(own('Hi Jane!') + own('Just following up.', false))
    assert.equal(t.messages.length, 2)
    assert.equal(t.messages[1].sender, 'Sam Sender')
    assert.equal(hasReplyAfter(t, who, null), false)
    assert.equal(hasReplyAfter(t, { ...who, ownName: null }, null), false)
  })

  it('an empty conversation has no reply', async () => {
    const t = await thread('')
    assert.equal(t.open, true)
    assert.deepEqual(t.messages, [])
    assert.equal(hasReplyAfter(t, who, null), false)
  })

  it('without the "--other" class, falls back to profile links and names – an unknown sender is never the lead', async () => {
    const t = await thread(named('Sam Sender', 'Hello') + named('Jane Doe, MBA', 'Hi there'))
    assert.ok(t.messages.every((m) => !m.other))
    assert.equal(hasReplyAfter(t, who, 'Hello'), true)
    assert.equal(hasReplyAfter(t, { leadName: 'Jane Doe' }, 'Hello'), true)
    assert.equal(hasReplyAfter(t, { ownName: 'Sam Sender' }, 'Hello'), false, 'the lead’s name is not known: not counted')
    const mine = await thread(named('Sam Sender', 'Hello') + named('Sam Sender', 'Anyone?'))
    assert.equal(hasReplyAfter(mine, who, null), false)
    // A placeholder own name (e.g. the email when the profile could not be read) never turns our messages into replies.
    for (const ownName of ['LinkedIn account', 'sam@example.com', null]) {
      assert.equal(hasReplyAfter(mine, { ...who, ownName, ownProfileUrl: null }, null), false, String(ownName))
      assert.deepEqual(authorsOf(mine, { ...who, ownName, ownProfileUrl: null }), ['unknown', 'unknown'])
    }
  })

  it('counts only the lead’s messages after our last campaign message', () => {
    const m = (from: 'me' | 'them', text: string): ThreadMessage => ({ sender: from === 'me' ? 'Sam Sender' : 'Jane Doe', senderHref: '', other: from === 'them', text, failed: false })
    const t = (...messages: ThreadMessage[]): ThreadSnapshot => ({
      open: true,
      title: 'Jane Doe',
      messages,
      inmail: false,
      composerText: '',
      sendFound: true,
      sendDisabled: true,
      closeFound: true,
      error: '',
      loading: false,
    })
    const old = t(m('them', 'Congrats on the new role!'), m('me', 'Thanks!'), m('me', 'Hi Jane, campaign message'))
    assert.equal(hasReplyAfter(old, who, 'Hi Jane, campaign message'), false)
    assert.equal(hasReplyAfter(old, who, null), false)
    const answered = t(m('me', 'Hi Jane, campaign message'), m('them', 'Interested!'), m('me', 'Manual answer by the user'))
    assert.equal(hasReplyAfter(answered, who, 'Hi Jane, campaign message'), true)
    assert.equal(hasReplyAfter(answered, who, 'a message not in the loaded history'), false, 'falls back to our latest message')
    assert.equal(hasReplyAfter(t(m('them', 'Thanks for connecting!')), who, null), true, 'nothing of ours yet: everything they wrote counts')

    assert.equal(alreadySent(t(m('me', 'Hi  Jane,\nhow are you?')), who, 'Hi Jane, how are you?'), true)
    assert.equal(alreadySent(t(m('me', 'Hi Jane'), m('them', 'Hey')), who, 'Hi Jane'), true, 'answered since')
    assert.equal(alreadySent(t(m('me', 'Hi Jane'), m('me', 'Other text')), who, 'Hi Jane'), false)
    assert.equal(alreadySent(t({ ...m('me', 'Hi Jane'), failed: true }), who, 'Hi Jane'), false, 'a failed copy was not delivered')
    assert.equal(alreadySent(t(m('them', 'Hi Jane')), who, 'Hi Jane'), false)
  })

  it('send errors come from LinkedIn’s markers, never from message text', async () => {
    const history = await thread(theirs("Sorry I couldn't send the deck – unable to send big files, it failed to send") + own('Message not sent? Try again later'))
    assert.equal(history.error, '')
    assert.deepEqual(history.messages.map((m) => m.failed), [false, false])
    const failed = await thread(own('Hi') + failedOwn('Hello again'))
    assert.deepEqual(failed.messages.map((m) => m.failed), [false, true])
    assert.equal(failed.error, '', 'the per-message marker is not a window error')
    const banner = await thread(own('Hi'), { LIST_EXTRA: '<div class="msg-form__error" role="alert">Message failed to send. Try again.</div>' })
    assert.match(banner.error, /failed to send/i)
  })

  it('InMail is decided by the message box, not by the history', async () => {
    const history = await thread(own('Following up on my InMail from last month') + theirs('Thanks for the InMail!'))
    assert.equal(history.inmail, false)
    const footer = await thread('', { FORM_EXTRA: '<span class="msg-inmail-credits-display">InMail credits: 4 left</span>' })
    assert.equal(footer.inmail, true)
    const subject = await thread('', { FORM_EXTRA: '<input name="subject" placeholder="Subject (optional)">' })
    assert.equal(subject.inmail, true)
  })

  it('flags a loading history', async () => {
    assert.equal((await thread('', { LIST_EXTRA: '<div class="artdeco-loader" style="height: 20px"></div>' })).loading, true)
    assert.equal((await thread('', { LIST_EXTRA: '<div class="artdeco-loader" style="display: none"></div>' })).loading, false)
  })

  it('compares typed text with what the editor shows', () => {
    assert.ok(sameMessage('Hi Jane,\n\nGreat to connect!', 'Hi Jane,\nGreat to connect!'))
    assert.ok(!sameMessage('Hi Ja', 'Hi Jane, great to connect!'))
    assert.ok(!sameMessage('Hi Jane, great to connect! Hi Jane, great to connect!', 'Hi Jane, great to connect!'), 'twice the text is not the text')
    assert.ok(!sameMessage('', ''))
    assert.equal(fitNote('a'.repeat(10), 300), 'a'.repeat(10))
    const fitted = fitNote('Hello Jane, I loved your talk about growth loops and would like to connect', 40)
    assert.ok(fitted.length <= 40 && !fitted.endsWith(' '))
    assert.equal(fitted, 'Hello Jane, I loved your talk about')
  })
})

describe('invitation dialogs', () => {
  const d = (text: string, buttons: string[], extra = {}) => ({ dialogs: [{ text, buttons, textarea: false, maxLength: null, emailInput: false, ...extra }], toasts: [] })
  it('classifies what LinkedIn shows after clicking Connect', () => {
    assert.equal(classifyInviteUi(d('Add a note to your invitation? Personalize…', ['Dismiss', 'Add a note', 'Send without a note'])).step, 'choose')
    assert.equal(classifyInviteUi(d('Add a note to your invitation', ['Dismiss', 'Send invitation'], { textarea: true, maxLength: 200 })).step, 'note')
    assert.equal(classifyInviteUi(d('Personalize your invitations with Premium. You’ve used all your free personalized invitations', ['Dismiss', 'Try Premium for ₹0'])).step, 'upsell')
    assert.equal(classifyInviteUi(d('You’ve reached the weekly invitation limit', ['Got it'])).step, 'limit')
    assert.equal(classifyInviteUi(d('To verify this member knows you, please enter their email to connect.', ['Send'], { emailInput: true })).step, 'email')
    assert.equal(classifyInviteUi(d('How do you know Jane?', ['Colleague', 'Other'])).step, 'other')
    assert.equal(classifyInviteUi({ dialogs: [], toasts: ['Your invitation to Jane Doe was sent.'] }).step, 'sent')
    assert.equal(classifyInviteUi({ dialogs: [], toasts: ['Invitation sent'] }).step, 'sent')
    assert.equal(classifyInviteUi({ dialogs: [], toasts: ['Invitation not sent. Try again later.'] }).step, 'failed')
    assert.equal(classifyInviteUi({ dialogs: [], toasts: [] }).step, 'none')
  })

  it('failure toasts that name the person are failures', () => {
    for (const toast of [
      'Your invitation to Jane Doe was not sent.',
      'Invitation to Jane Doe not sent. Try again later',
      'Your invitation to Jane Doe couldn’t be sent',
      'Your invitation to Jane Doe could not be sent.',
      'Invitation to Jane Doe failed',
    ]) {
      assert.equal(classifyInviteUi({ dialogs: [], toasts: [toast] }).step, 'failed', toast)
    }
  })

  it('a chat window (role="dialog") is never the invitation dialog', async () => {
    const chat = `<div id="interop-outlet"></div><script>
      document.getElementById('interop-outlet').attachShadow({ mode: 'open' }).innerHTML =
        '<aside class="msg-overlay-container"><div class="msg-overlay-conversation-bubble" role="dialog" style="width:300px;height:300px">Bob Smith<form class="msg-form"><div contenteditable="true">Draft</div><button>Send</button></form></div></aside>'
    </script>`
    const modal = `<div role="dialog" class="artdeco-modal send-invite" style="width:500px;height:200px"><h2>Add a note to your invitation?</h2>
      <button aria-label="Add a note">Add a note</button><button aria-label="Send without a note">Send without a note</button></div>`
    const onlyChat = await pageWith(`<html><body><main><h1>Jane</h1></main>${chat}</body></html>`)
    try {
      const ui = await onlyChat.evaluate(readInviteUiInPage, 'tok')
      assert.deepEqual(ui.dialogs, [])
      assert.equal(classifyInviteUi(ui).step, 'none')
    } finally {
      await closePage(onlyChat)
    }
    const both = await pageWith(`<html><body><main><h1>Jane</h1></main>${modal}${chat}</body></html>`)
    try {
      const ui = await both.evaluate(readInviteUiInPage, 'tok')
      assert.equal(ui.dialogs.length, 1)
      assert.equal(classifyInviteUi(ui).step, 'choose')
      assert.equal(await both.locator('[data-la-dialog="tok"]').getAttribute('class'), 'artdeco-modal send-invite')
    } finally {
      await closePage(both)
    }
  })
})

describe('recent activity', () => {
  it('finds the latest post and its Like state', async () => {
    for (const [posts, liked, expected] of [
      ['posts', 'no', { posts: 2, like: 'unpressed' }],
      ['posts', 'liked', { posts: 2, like: 'pressed' }],
      ['none', 'no', { posts: 0, like: 'missing', empty: true }],
    ] as const) {
      const page = await pageWith(fixture('recent-activity.html', { POSTS: posts, LIKED: liked }))
      const snap = await page.evaluate(readPostsInPage, 'tok')
      for (const [k, v] of Object.entries(expected)) assert.equal(snap[k as keyof typeof snap], v, `${posts}/${liked}: ${k}`)
      if (snap.like !== 'missing') assert.equal(await page.locator('[data-la-like="tok"]').count(), 1)
      await closePage(page)
    }
  })
})

describe('message box selection', () => {
  it('ignores editors that are not message boxes', async () => {
    const page = await pageWith(`<main><h1>Jane</h1>
      <div class="comments-comment-box__form"><div class="ql-editor" contenteditable="true" aria-label="Add a comment…" style="width:500px;height:80px"></div></div></main>`)
    assert.deepEqual(await page.evaluate(listConversationsInPage, 'tok'), [])
    assert.equal((await page.evaluate(readThreadInPage, 'tok')).open, false)
    await closePage(page)
  })
})
