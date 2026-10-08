/**
 * PlaywrightDriver end-to-end against scripted LinkedIn pages served at linkedin.com URLs.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { Page } from 'playwright'
import { PlaywrightDriver } from '../src/linkedin/playwright/driver.ts'
import { LinkedInError } from '../src/linkedin/types.ts'
import { closeBrowser, closePage, FAST, linkedInPage } from './helpers/linkedin-browser.ts'
import { fakeSite, type ProfileConfig } from './helpers/linkedin-fake-site.ts'

const site = fakeSite()
let page: Page
let driver: PlaywrightDriver

before(async () => {
  page = await linkedInPage(site.handler)
  await page.context().addCookies([{ name: 'li_at', value: site.newSession(), domain: '.linkedin.com', path: '/', secure: true, httpOnly: true, sameSite: 'None' }])
  driver = new PlaywrightDriver(page, { pacing: FAST, ownName: 'Sam Sender', ownProfileUrl: 'https://www.linkedin.com/in/sam-sender/' })
})
after(async () => {
  await closePage(page)
  await closeBrowser()
})

let k = 0
/** A fresh scripted profile; returns its URL. */
function person(cfg: ProfileConfig = {}) {
  const id = `jane-doe-${++k}`
  site.profiles.set(id, cfg)
  return `https://www.linkedin.com/in/${id}/`
}
const log = () => page.evaluate(() => (window as unknown as { __log: { type: string; [k: string]: unknown }[] }).__log)
const rejectsWith = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof LinkedInError && e.code === code)

describe('PlaywrightDriver: profiles', () => {
  it('views a profile', async () => {
    const p = await driver.viewProfile(person())
    assert.deepEqual(p, {
      firstName: 'Jane',
      lastName: 'Doe',
      headline: 'Head of Growth at Acme Corp',
      company: 'Acme Corp',
      location: 'Austin, Texas, United States',
      profileUrl: `https://www.linkedin.com/in/jane-doe-${k}/`,
      connection: 'not_connected',
    })
    assert.equal(await driver.getConnectionStatus(person({ state: 'connected' })), 'connected')
    assert.equal(await driver.getConnectionStatus(person({ state: 'pending' })), 'pending')
  })

  it('opens a lazily rendered More menu when the card is not conclusive', async () => {
    assert.equal(await driver.getConnectionStatus(person({ layout: 'follow-primary', lazyMenu: true, state: 'pending', degree: '3rd' })), 'pending')
  })

  it('maps missing profiles and signed-out sessions to LinkedInError codes', async () => {
    await rejectsWith(driver.viewProfile('https://www.linkedin.com/in/ghost/'), 'not_found')
    await rejectsWith(driver.viewProfile('not a url'), 'not_found')
    const other = await linkedInPage(site.handler) // no li_at cookie
    const anon = new PlaywrightDriver(other, { pacing: FAST })
    await rejectsWith(anon.viewProfile(person()), 'session_expired')
    await rejectsWith(anon.searchPeople('https://www.linkedin.com/search/results/people/?keywords=x', 1), 'session_expired')
    await closePage(other)
  })
})

describe('PlaywrightDriver: invitations', () => {
  it('sends an invitation with a note and then sees it pending', async () => {
    const url = person()
    assert.equal(await driver.sendInvite(url, 'Hi Jane, loved your talk on growth loops!'), 'sent')
    assert.deepEqual((await log()).filter((e) => e.type === 'invite'), [{ type: 'invite', note: 'Hi Jane, loved your talk on growth loops!' }])
    assert.equal(await driver.getConnectionStatus(url), 'pending')
    assert.equal(await driver.sendInvite(url, null), 'pending')
  })

  it('sends without a note when none is given', async () => {
    assert.equal(await driver.sendInvite(person(), null), 'sent')
    assert.deepEqual((await log()).filter((e) => e.type === 'invite'), [{ type: 'invite', note: null }])
  })

  it('truncates a note to the box limit', async () => {
    assert.equal(await driver.sendInvite(person(), 'word '.repeat(60).trim()), 'sent')
    const note = (await log()).find((e) => e.type === 'invite')!.note as string
    assert.ok(note.length <= 200 && note.startsWith('word word'))
  })

  it('falls back to no note when LinkedIn shows the Premium upsell', async () => {
    assert.equal(await driver.sendInvite(person({ mode: 'upsell' }), 'Hi Jane!'), 'sent_without_note')
    assert.deepEqual((await log()).filter((e) => e.type === 'invite'), [{ type: 'invite', note: null }])
  })

  it('handles invitations sent without any dialog', async () => {
    assert.equal(await driver.sendInvite(person({ mode: 'direct' }), null), 'sent')
    assert.equal(await driver.sendInvite(person({ mode: 'direct' }), 'Hi'), 'sent_without_note')
  })

  it('finds Connect in a lazily rendered More menu and never clicks other people', async () => {
    assert.equal(await driver.sendInvite(person({ layout: 'follow-primary', lazyMenu: true, degree: '3rd+' }), 'Hello Jane'), 'sent')
    const events = await log()
    assert.ok(events.some((e) => e.type === 'invite' && e.note === 'Hello Jane'))
    assert.ok(!events.some((e) => e.type === 'wrong-click'))
  })

  it('reports existing connections', async () => {
    assert.equal(await driver.sendInvite(person({ state: 'connected' }), 'Hi'), 'already_connected')
  })

  it('maps the weekly limit and the email requirement', async () => {
    await rejectsWith(driver.sendInvite(person({ mode: 'limit' }), null), 'rate_limited')
    await rejectsWith(driver.sendInvite(person({ mode: 'email' }), 'Hi'), 'action_unavailable')
  })

  it('withdraws a pending invitation', async () => {
    const url = person({ state: 'pending' })
    assert.equal(await driver.withdrawInvite(url), 'withdrawn')
    assert.ok((await log()).some((e) => e.type === 'withdraw'))
    assert.equal(await driver.withdrawInvite(url), 'not_pending')
  })
})

describe('PlaywrightDriver: follow and like', () => {
  it('follows (from the More menu) once', async () => {
    const url = person()
    assert.equal(await driver.follow(url), 'followed')
    assert.equal(await driver.follow(url), 'already_following')
    assert.ok(!(await log()).some((e) => e.type === 'wrong-click'))
  })

  it('likes the latest post', async () => {
    const url = person()
    assert.equal(await driver.likeLatestPost(url), 'liked')
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __log: unknown[] }).__log), [{ type: 'like', liked: true }])
    assert.equal(await driver.likeLatestPost(person({ liked: true })), 'already_liked')
    assert.equal(await driver.likeLatestPost(person({ posts: 'none' })), 'no_posts')
  })
})

describe('PlaywrightDriver: messages', () => {
  const idOf = (url: string) => url.split('/')[4]
  const threadOf = (url: string) => site.profiles.get(idOf(url))!.thread ?? []
  const sentEvents = async () => (await log()).filter((e) => e.type === 'message')

  it('sends a message to a connection in the shadow-DOM overlay', async () => {
    const url = person({ state: 'connected', thread: [{ from: 'me', text: 'Thanks for connecting!' }] })
    const text = 'Hi Jane,\nquick question about Acme’s growth team 🚀'
    assert.equal(await driver.sendMessage(url, text, { stopIfRepliedAfter: { after: 'Thanks for connecting!' } }), 'sent')
    const events = await log()
    const sent = events.find((e) => e.type === 'message')
    assert.ok(sent, 'message submitted')
    assert.equal((sent.text as string).replace(/\s+/g, ' '), text.replace(/\s+/g, ' '))
    assert.ok(events.some((e) => e.type === 'close'), 'conversation closed afterwards')
    assert.equal(threadOf(url).length, 2)
  })

  it('stops when the lead replied after our last campaign message, not for older history', async () => {
    const url = person({ state: 'connected', thread: [{ from: 'me', text: 'Hi' }, { from: 'them', text: 'Hey!' }] })
    assert.equal(await driver.sendMessage(url, 'Following up', { stopIfRepliedAfter: { after: 'Hi' } }), 'replied')
    assert.deepEqual(await sentEvents(), [])
    // The first message of a campaign is sent without a reply check, whatever the history.
    assert.equal(await driver.sendMessage(url, 'Following up', {}), 'sent')

    // They wrote long ago; our campaign message came after that: no reply to it yet.
    const old = person({ state: 'connected', thread: [{ from: 'them', text: 'Congrats on the new role!' }, { from: 'me', text: 'Hi Jane, quick question' }] })
    assert.equal(await driver.sendMessage(old, 'Just following up', { stopIfRepliedAfter: { after: 'Hi Jane, quick question' } }), 'sent')
  })

  it('does not message non-connections', async () => {
    assert.equal(await driver.sendMessage(person(), 'Hi', {}), 'not_connected')
    assert.equal(await driver.sendMessage(person({ state: 'pending' }), 'Hi', {}), 'not_connected')
  })

  it('detects replies relative to our last campaign message', async () => {
    const thread = [
      { from: 'them' as const, text: 'Old chat from last year' },
      { from: 'me' as const, text: 'Hi Jane, campaign message' },
    ]
    assert.equal(await driver.hasReplied(person({ state: 'connected', thread }), { after: 'Hi Jane, campaign message' }), false)
    assert.equal(await driver.hasReplied(person({ state: 'connected', thread }), { after: null }), false, 'history before our latest message is not a reply')
    const answered = [...thread, { from: 'them' as const, text: 'Sure, let’s talk' }, { from: 'me' as const, text: 'Great, booking a call' }]
    assert.equal(await driver.hasReplied(person({ state: 'connected', thread: answered }), { after: 'Hi Jane, campaign message' }), true)
    assert.equal(await driver.hasReplied(person({ state: 'connected', thread: answered }), { after: null }), false, 'nothing after our latest message')
    assert.equal(await driver.hasReplied(person({ state: 'connected', thread: [{ from: 'me', text: 'Hi' }] }), { after: 'Hi' }), false)
    assert.equal(await driver.hasReplied(person({ state: 'connected' }), { after: null }), false)
    assert.equal(await driver.hasReplied(person(), { after: null }), false, 'InMail prompt for non-connections')
  })

  it('is idempotent: a message already delivered by an earlier attempt is not sent again', async () => {
    const text = 'Hi Jane, here is the pricing sheet you asked for.'
    const url = person({ state: 'connected', thread: [{ from: 'them', text: 'Can you send pricing?' }, { from: 'me', text }] })
    assert.equal(await driver.sendMessage(url, `  ${text.replace(/ /g, '  ')} `, { stopIfRepliedAfter: { after: null } }), 'already_sent')
    assert.deepEqual(await sentEvents(), [])
    // …even when the lead answered it in the meantime (with a reply check, that is a reply).
    const answered = person({ state: 'connected', thread: [{ from: 'me', text: 'Hi Jane' }, { from: 'me', text }, { from: 'them', text: 'Thanks!' }] })
    assert.equal(await driver.sendMessage(answered, text, {}), 'already_sent')
    assert.equal(await driver.sendMessage(answered, text, { stopIfRepliedAfter: { after: 'Hi Jane' } }), 'replied')
    assert.equal(threadOf(answered).length, 3)
  })

  it('a send LinkedIn did not confirm is not repeated on the retry', async () => {
    const url = person({ state: 'connected', confirm: false })
    const text = 'Hi Jane, following up on our chat'
    await rejectsWith(driver.sendMessage(url, text, {}), 'unknown')
    assert.equal(threadOf(url).length, 1, 'LinkedIn did deliver it')
    assert.equal(await driver.sendMessage(url, text, {}), 'already_sent')
    assert.deepEqual(threadOf(url).map((m) => m.text), [text])
  })

  it('a message LinkedIn flags as failed is reported, and sent again on the retry', async () => {
    const url = person({ state: 'connected', sendFails: true })
    await rejectsWith(driver.sendMessage(url, 'Hello Jane', {}), 'unknown')
    site.profiles.get(idOf(url))!.sendFails = false
    assert.equal(await driver.sendMessage(url, 'Hello Jane', {}), 'sent')
    assert.deepEqual(threadOf(url).map((m) => [m.text, !!m.failed]), [
      ['Hello Jane', true],
      ['Hello Jane', false],
    ])
  })

  it('send errors are read from the new message only, never from the history text', async () => {
    const history = person({ state: 'connected', thread: [{ from: 'them', text: "Sorry I couldn't send the deck yesterday – unable to send large files. Message failed to send twice!" }] })
    assert.equal(await driver.sendMessage(history, 'No worries, here is a link instead', {}), 'sent')
    assert.equal(threadOf(history).length, 2)
    const own = person({ state: 'connected' })
    assert.equal(await driver.sendMessage(own, 'Hi Jane, my earlier email failed to send, so writing here.', {}), 'sent')
    assert.equal(threadOf(own).length, 1)
  })

  it('a conversation whose history mentions InMail is still a normal conversation', async () => {
    const thread = [
      { from: 'me' as const, text: 'Hi Jane, following up on my InMail from last month.' },
      { from: 'them' as const, text: 'Sure, happy to chat.' },
    ]
    assert.equal(await driver.hasReplied(person({ state: 'connected', thread }), { after: thread[0].text }), true)
    assert.equal(await driver.sendMessage(person({ state: 'connected', thread }), 'Great – does Tuesday work?', {}), 'sent')
  })

  it('types and sends only in the lead’s window when another chat pops up meanwhile', async () => {
    const url = person({ state: 'connected', chat: { name: 'Bob Smith', on: 'type' } })
    const text = 'Hi Jane, here is the pricing sheet you asked for.'
    assert.equal(await driver.sendMessage(url, text, {}), 'sent')
    const events = await log()
    assert.ok(!events.some((e) => e.type === 'chat-message'), 'nothing sent to Bob')
    assert.deepEqual(threadOf(url).map((m) => m.text), [text])
  })

  it('closes other chat windows before opening the lead’s conversation', async () => {
    const url = person({ state: 'connected', chat: { name: 'Bob Smith', on: 'load', draft: 'Draft for Bob' } })
    assert.equal(await driver.sendMessage(url, 'Hello Jane', {}), 'sent')
    const events = await log()
    assert.ok(events.some((e) => e.type === 'chat-close'))
    assert.ok(!events.some((e) => e.type === 'chat-message'))
  })

  it('waits for a slowly loading history before deciding about replies', async () => {
    const thread = [
      { from: 'me' as const, text: 'Hi Jane' },
      { from: 'them' as const, text: 'Hey, interested!' },
    ]
    assert.equal(await driver.hasReplied(person({ state: 'connected', thread, historyDelayMs: 1500 }), { after: 'Hi Jane' }), true, 'with a loader')
    assert.equal(await driver.hasReplied(person({ state: 'connected', thread, historyDelayMs: 600, historyLoader: false }), { after: 'Hi Jane' }), true, 'without a loader')
    const url = person({ state: 'connected', thread, historyDelayMs: 1500 })
    assert.equal(await driver.sendMessage(url, 'Following up', { stopIfRepliedAfter: { after: 'Hi Jane' } }), 'replied')
    assert.deepEqual(await sentEvents(), [])
  })

  it('a history that never finishes loading is an error, not "no reply"', async () => {
    await rejectsWith(driver.hasReplied(person({ state: 'connected', thread: [{ from: 'them', text: 'Hi' }], historyDelayMs: 60_000 }), { after: null }), 'unknown')
  })

  it('without LinkedIn’s markers, attributes messages by the lead’s name and never assumes unknown senders replied', async () => {
    const own = new PlaywrightDriver(page, { pacing: FAST, ownName: null, ownProfileUrl: null })
    const mine = person({ state: 'connected', markers: false, thread: [{ from: 'me', text: 'Hi Jane' }] })
    assert.equal(await own.hasReplied(mine, { after: 'Hi Jane' }), false)
    const answered = person({ state: 'connected', markers: false, thread: [{ from: 'me', text: 'Hi Jane' }, { from: 'them', text: 'Hello Sam' }] })
    assert.equal(await own.hasReplied(answered, { after: 'Hi Jane' }), true)
  })
})

describe('PlaywrightDriver: robustness', () => {
  it('never takes a chat window for the invitation dialog', async () => {
    const url = person({ chat: { name: 'Bob Smith', on: 'connect', draft: 'Draft for Bob' } })
    assert.equal(await driver.sendInvite(url, 'Hi Jane, loved your talk!'), 'sent')
    const events = await log()
    assert.deepEqual(events.filter((e) => e.type === 'invite'), [{ type: 'invite', note: 'Hi Jane, loved your talk!' }])
    assert.ok(!events.some((e) => e.type === 'chat-message'), 'Bob’s draft was not sent')
    // An open chat on page load is closed before connecting.
    assert.equal(await driver.sendInvite(person({ chat: { name: 'Bob Smith', on: 'load', draft: 'Draft' } }), null), 'sent')
    assert.ok(!(await log()).some((e) => e.type === 'chat-message'))
  })

  it('profile text about limits or errors does not look like LinkedIn throttling', async () => {
    const about = "I help SDRs prospect without hitting LinkedIn's commercial use limit. Too many requests? Page not found? This profile is not available to bots."
    const url = person({ about })
    assert.equal((await driver.viewProfile(url)).firstName, 'Jane')
    assert.equal(await driver.sendInvite(url, null), 'sent')
  })

  it('a non-English LinkedIn interface is an account problem, not a missing button', async () => {
    await rejectsWith(driver.viewProfile(person({ lang: 'de' })), 'account_problem')
    await rejectsWith(driver.sendInvite(person({ lang: 'fr-FR' }), null), 'account_problem')
    assert.equal(await driver.getConnectionStatus(person({ lang: 'en-US', state: 'connected' })), 'connected')
  })

  it('network failures and a closed browser are transient', async () => {
    await page.route('**/in/offline-*/', (r) => r.abort('internetdisconnected'))
    try {
      await assert.rejects(driver.viewProfile('https://www.linkedin.com/in/offline-olga/'), (e: unknown) => {
        return e instanceof LinkedInError && e.code === 'transient' && /ERR_INTERNET_DISCONNECTED/.test(e.message)
      })
    } finally {
      await page.unroute('**/in/offline-*/')
    }
    const other = await linkedInPage(site.handler)
    const gone = new PlaywrightDriver(other, { pacing: FAST })
    await closePage(other)
    await rejectsWith(gone.viewProfile(person()), 'transient')
  })

  it('starts no irreversible action once the server is shutting down', async () => {
    const closing = new PlaywrightDriver(page, { pacing: FAST, ownName: 'Sam Sender', ownProfileUrl: 'https://www.linkedin.com/in/sam-sender/', isClosing: () => true })
    await rejectsWith(closing.sendMessage(person({ state: 'connected' }), 'Hello', {}), 'transient')
    assert.deepEqual((await log()).filter((e) => e.type === 'message'), [])
    await rejectsWith(closing.sendInvite(person(), null), 'transient')
    assert.deepEqual((await log()).filter((e) => e.type === 'invite'), [])
    assert.equal(await closing.getConnectionStatus(person()), 'not_connected', 'reading is fine')
  })
})

describe('PlaywrightDriver: search limit', () => {
  const url = 'https://www.linkedin.com/search/results/people/?keywords=growth'
  it('only LinkedIn’s banner means the monthly search limit, never a result’s headline', async () => {
    site.searchLimitHeadline = true
    try {
      assert.equal((await driver.searchPeople(url, 1)).people.length, 8)
    } finally {
      site.searchLimitHeadline = false
    }
    site.searchLimitBanner = true
    try {
      await rejectsWith(driver.searchPeople(url, 1), 'rate_limited')
    } finally {
      site.searchLimitBanner = false
    }
  })
})

describe('PlaywrightDriver: search', () => {
  it('collects people page by page', async () => {
    const url = 'https://www.linkedin.com/search/results/people/?keywords=growth&origin=GLOBAL_SEARCH_HEADER'
    const p1 = await driver.searchPeople(url, 1)
    assert.equal(p1.people.length, 8)
    assert.equal(p1.hasMore, true)
    assert.equal(p1.people[0].profileUrl, 'https://www.linkedin.com/in/priya-sharma-42/')
    const p2 = await driver.searchPeople(url, 2)
    assert.equal(p2.people.length, 3)
    assert.equal(p2.hasMore, false)
    assert.ok(site.visits.includes('/search/results/people/'))
    await rejectsWith(driver.searchPeople('https://www.linkedin.com/in/jane/', 1), 'action_unavailable')
  })
})
