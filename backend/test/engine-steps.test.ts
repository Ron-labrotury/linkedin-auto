/** Engine: what each step does and how results / failures are written (docs/ENGINE.md "Steps", "Failures"). */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Duration } from '../../shared/types.ts'
import { run } from '../src/db/index.ts'
import { reconcileLeads } from '../src/engine/reconcile.ts'
import { deferred, linkedInError, until } from './helpers/engine-fakes.ts'
import {
  DAY,
  HOUR,
  MIN,
  T0,
  account,
  activities,
  addCampaign,
  campaignStatus,
  addLeads,
  addUser,
  getLead,
  linear,
  profile,
  setup,
  tree,
} from './helpers/engine-setup.ts'

const GAP = 3 * MIN // rand 0.5 with the default 1–5 min gap
const THU_9 = Date.parse('2026-10-08T09:00:00.000Z')

/** A user with one active campaign and one lead (due now). */
function one(sequence: Parameters<typeof addCampaign>[2]['sequence'], opts: { settings?: Parameters<typeof addCampaign>[2]['settings']; lead?: Parameters<typeof addLeads>[3][number] } = {}) {
  const e = setup()
  const user = addUser(e.db)
  const campaign = addCampaign(e.db, user, { sequence, settings: opts.settings, name: 'Q4 Outreach' })
  const [lead] = addLeads(e.db, user, campaign, [opts.lead ?? 'jane-doe-1234'])
  return { e, user, campaign, lead }
}

describe('engine steps: view_profile', () => {
  it('fills empty and URL-guessed fields, marks a connection and advances with the next step delay', async () => {
    const { e, user, campaign, lead } = one(linear('view_profile', { kind: 'follow', delay: { min: 1, max: 5, unit: 'minutes' } }))
    e.li.queue('viewProfile', {
      firstName: 'Jane',
      lastName: 'Doe-Smith',
      headline: 'CTO at Initech',
      company: 'Initech',
      location: 'Berlin',
      profileUrl: profile('jane-doe-1234'),
      connection: 'connected',
    })
    await e.engine.tick()

    assert.deepEqual(e.li.calls.map((c) => [c.method, c.args[0]]), [['viewProfile', profile('jane-doe-1234')]])
    const l = getLead(e.db, lead)
    assert.equal(l.first_name, 'Jane')
    assert.equal(l.last_name, 'Doe-Smith')
    assert.equal(l.headline, 'CTO at Initech')
    assert.equal(l.company, 'Initech')
    assert.equal(l.location, 'Berlin')
    assert.equal(l.status, 'connected')
    assert.equal(l.connected_at, T0)
    assert.equal(l.invited_at, null)
    assert.equal(l.last_action, 'Viewed profile')
    assert.equal(l.last_action_at, T0)
    assert.equal(l.current_step_id, 's2')
    assert.equal(l.next_action_at, T0 + 3 * MIN) // pickDelayMs(1–5 min, 0.5)
    assert.equal(l.step_started_at, T0 + 3 * MIN)
    assert.equal(l.attempts, 0)

    const acts = activities(e.db, user)
    assert.equal(acts.length, 1) // not invited → no "accepted"
    assert.deepEqual(
      { ...acts[0], created_at: undefined },
      {
        type: 'view_profile',
        status: 'success',
        detail: 'Viewed profile',
        campaign_id: campaign,
        campaign_name: 'Q4 Outreach',
        lead_id: lead,
        lead_name: 'Jane Doe-Smith',
        step_id: 's1',
        created_at: undefined,
      },
    )
  })

  it('keeps names and fields the user provided', async () => {
    const { e, lead } = one(linear('view_profile'), {
      lead: { profileUrl: profile('john-smith'), firstName: 'Johnny', lastName: 'S', company: 'Acme' },
    })
    e.li.queue('viewProfile', {
      firstName: 'John',
      lastName: 'Smith',
      headline: 'Founder',
      company: 'Other Co',
      location: 'Paris',
      profileUrl: profile('john-smith'),
      connection: 'not_connected',
    })
    await e.engine.tick()
    const l = getLead(e.db, lead)
    assert.deepEqual([l.first_name, l.last_name, l.company, l.headline, l.location], ['Johnny', 'S', 'Acme', 'Founder', 'Paris'])
    assert.equal(l.status, 'finished') // last step → finished
    assert.equal(l.connected_at, null)
  })

  it('records "accepted" when an invited lead turns out to be connected', async () => {
    const { e, user, lead } = one(linear('view_profile', { kind: 'follow', delay: { min: 1, max: 1, unit: 'days' } }))
    run(e.db, `UPDATE leads SET status = 'invited', invited_at = ? WHERE id = ?`, T0 - DAY, lead)
    e.li.handle('viewProfile', (url: string) => ({ firstName: 'Jane', lastName: 'Doe', headline: '', company: '', location: '', profileUrl: url, connection: 'connected' }))
    await e.engine.tick()
    assert.equal(getLead(e.db, lead).status, 'connected')
    assert.deepEqual(activities(e.db, user).map((a) => a.type), ['accepted', 'view_profile'])
  })
})

describe('engine steps: invite', () => {
  const inviteThenWait = (note: string) =>
    linear({ kind: 'invite', config: { message: note } }, { kind: 'follow', delay: { min: 1, max: 1, unit: 'days' } })

  it('sends a personalised note and marks the lead invited', async () => {
    const { e, user, lead } = one(inviteThenWait('Hi {{first_name}}, fellow {{title}} at {{ company }}!'), {
      lead: { profileUrl: profile('jane-doe-1234'), firstName: 'Jane', lastName: 'Doe', headline: 'CTO', company: 'Initech' },
    })
    await e.engine.tick()
    assert.deepEqual(e.li.callsOf('sendInvite')[0].args, [profile('jane-doe-1234'), 'Hi Jane, fellow CTO at Initech!'])
    const l = getLead(e.db, lead)
    assert.equal(l.status, 'invited')
    assert.equal(l.invited_at, T0)
    assert.equal(l.last_action, 'Invite sent')
    assert.equal(l.current_step_id, 's2')
    assert.equal(l.next_action_at, T0 + DAY)
    const [a] = activities(e.db, user)
    assert.deepEqual([a.type, a.status, a.detail], ['invite', 'success', 'Invite sent with a note'])
  })

  it('sends no note when the note is empty, and clips long notes to 300 characters (saying so in the activity)', async () => {
    const a = one(inviteThenWait(''))
    await a.e.engine.tick()
    assert.equal(a.e.li.callsOf('sendInvite')[0].args[1], null)
    assert.equal(activities(a.e.db, a.user)[0].detail, 'Invite sent without a note')

    const b = one(inviteThenWait('Hello {{title}} at {{company}}'), {
      lead: { profileUrl: profile('x-y'), headline: 'word '.repeat(70).trim(), company: 'Initech' },
    })
    await b.e.engine.tick()
    const note = b.e.li.callsOf('sendInvite')[0].args[1] as string
    assert.ok(note.length <= 300 && note.length > 250 && note.startsWith('Hello word word') && note.endsWith('word'), note)
    assert.equal(activities(b.e.db, b.user)[0].detail, 'Invite sent with a note (shortened to 300 characters)')
  })

  it('a 295-character note that only exceeds 300 characters once personalised is shortened, and the activity says so', async () => {
    const raw = `Hi {{first_name}}, ${'x'.repeat(240)} at {{company}} keep going`
    assert.ok(raw.length <= 300)
    const { e, user } = one(inviteThenWait(raw), {
      lead: { profileUrl: profile('jane-doe-1234'), firstName: 'Jane', lastName: 'Doe', company: 'International Business Machines Corporation' },
    })
    await e.engine.tick()
    const note = e.li.callsOf('sendInvite')[0].args[1] as string
    assert.ok(note.length <= 300, String(note.length))
    assert.ok(!note.endsWith('keep going'))
    const [a] = activities(e.db, user)
    assert.deepEqual([a.status, a.detail], ['success', 'Invite sent with a note (shortened to 300 characters)'])
  })

  it('reads the profile first when the note needs a name that was only guessed from the URL', async () => {
    const { e, lead } = one(inviteThenWait('Hi {{first_name}} at {{company}}'), { lead: 'mjohnson' })
    e.li.queue('viewProfile', { firstName: 'Mike', lastName: 'Johnson', headline: 'CTO', company: 'Initech', location: 'Pune', profileUrl: profile('mjohnson'), connection: 'not_connected' })
    await e.engine.tick()
    assert.equal(e.li.callsOf('viewProfile').length, 1)
    assert.equal(e.li.callsOf('sendInvite')[0].args[1], 'Hi Mike at Initech')
    const l = getLead(e.db, lead)
    assert.deepEqual([l.first_name, l.last_name, l.company, l.status], ['Mike', 'Johnson', 'Initech', 'invited'])
  })

  it('does not read the profile when the lead already has what the note uses', async () => {
    const a = one(inviteThenWait('Hi {{first_name}}'), { lead: { profileUrl: profile('jd-1234'), firstName: 'Jane', lastName: 'Doe' } })
    await a.e.engine.tick()
    assert.equal(a.e.li.callsOf('viewProfile').length, 0)
    const b = one(inviteThenWait('Hello there'), { lead: 'mjohnson' })
    await b.e.engine.tick()
    assert.equal(b.e.li.callsOf('viewProfile').length, 0)
  })

  it('reports an invite LinkedIn sent without the note', async () => {
    const { e, user, lead } = one(inviteThenWait('Hi {{first_name}}'))
    e.li.queue('sendInvite', 'sent_without_note')
    await e.engine.tick()
    assert.equal(getLead(e.db, lead).status, 'invited')
    const [a] = activities(e.db, user)
    assert.deepEqual([a.status, a.detail], ['success', 'Invite sent without a note (LinkedIn did not allow one)'])
  })

  it('already connected (skipConnected false): invite skipped, status connected, the sequence continues', async () => {
    const { e, user, lead } = one(inviteThenWait(''), { settings: { skipConnected: false } })
    e.li.queue('sendInvite', 'already_connected')
    await e.engine.tick()
    const l = getLead(e.db, lead)
    assert.equal(l.status, 'connected')
    assert.equal(l.connected_at, T0)
    assert.equal(l.invited_at, null)
    assert.equal(l.current_step_id, 's2')
    assert.equal(l.next_action_at, T0 + DAY)
    assert.equal(l.last_action, 'Already connected')
    const [a] = activities(e.db, user)
    assert.deepEqual([a.type, a.status, a.detail], ['invite', 'skipped', 'Already connected'])
  })

  it('already connected (skipConnected true): the lead leaves the campaign as skipped', async () => {
    const { e, user, campaign, lead } = one(inviteThenWait(''), { settings: { skipConnected: true } })
    e.li.queue('sendInvite', 'already_connected')
    await e.engine.tick()
    const l = getLead(e.db, lead)
    assert.deepEqual(
      [l.status, l.current_step_id, l.next_action_at, l.last_action, l.last_action_at, l.connected_at, l.error],
      ['skipped', null, null, 'Already a connection – skipped', T0, T0, null],
    )
    assert.deepEqual(activities(e.db, user).map((a) => [a.type, a.status, a.detail]), [['invite', 'skipped', 'Already connected – lead skipped']])
    await e.tickAfterGap()
    assert.deepEqual(e.li.calls.map((c) => c.method), ['sendInvite']) // nothing more for this lead
    assert.equal(campaignStatus(e.db, campaign), 'completed')
  })

  it('skipConnected does not skip a lead this campaign invited or already messaged', async () => {
    const invitedBefore = one(inviteThenWait(''), { settings: { skipConnected: true } })
    run(invitedBefore.e.db, `UPDATE leads SET status = 'invited', invited_at = ? WHERE id = ?`, T0 - DAY, invitedBefore.lead)
    invitedBefore.e.li.queue('sendInvite', 'already_connected')
    await invitedBefore.e.engine.tick()
    let l = getLead(invitedBefore.e.db, invitedBefore.lead)
    assert.deepEqual([l.status, l.current_step_id, l.connected_at], ['connected', 's2', T0])
    assert.deepEqual(activities(invitedBefore.e.db, invitedBefore.user).map((a) => a.type), ['accepted', 'invite'])

    const messaged = one(inviteThenWait(''), { settings: { skipConnected: true } })
    run(messaged.e.db, `UPDATE leads SET last_message_text = 'Hi', last_action_at = ? WHERE id = ?`, T0 - DAY, messaged.lead)
    messaged.e.li.queue('sendInvite', 'already_connected')
    await messaged.e.engine.tick()
    l = getLead(messaged.e.db, messaged.lead)
    assert.deepEqual([l.status, l.current_step_id], ['connected', 's2'])
  })

  it('invite already pending: skipped, invited_at kept or set, status ≥ invited', async () => {
    const { e, user, lead } = one(inviteThenWait(''))
    e.li.queue('sendInvite', 'pending')
    await e.engine.tick()
    const l = getLead(e.db, lead)
    assert.equal(l.status, 'invited')
    assert.equal(l.invited_at, T0)
    const [a] = activities(e.db, user)
    assert.deepEqual([a.status, a.detail], ['skipped', 'Invite already pending'])
  })

  it('never downgrades the lead status', async () => {
    const { e, lead } = one(inviteThenWait(''))
    run(e.db, `UPDATE leads SET status = 'connected', connected_at = ? WHERE id = ?`, T0 - DAY, lead)
    e.li.queue('sendInvite', 'pending')
    await e.engine.tick()
    assert.equal(getLead(e.db, lead).status, 'connected')
    assert.equal(getLead(e.db, lead).connected_at, T0 - DAY)

    const r = one(inviteThenWait(''))
    run(r.e.db, `UPDATE leads SET status = 'replied', replied_at = ? WHERE id = ?`, T0 - DAY, r.lead)
    await r.e.engine.tick() // "sent"
    assert.equal(getLead(r.e.db, r.lead).status, 'replied')
    assert.equal(getLead(r.e.db, r.lead).invited_at, T0)
  })
})

describe('engine steps: message', () => {
  const msgThenFollow = (text = 'Hi {{first_name}}, quick question about {{company}}') =>
    linear({ kind: 'message', config: { message: text } }, { kind: 'follow', delay: { min: 2, max: 2, unit: 'hours' } })

  it("sends the campaign's first message without a reply check, stores its text and marks the lead connected", async () => {
    for (const stopOnReply of [true, false]) {
      const { e, user, lead } = one(msgThenFollow(), { settings: { stopOnReply }, lead: { profileUrl: profile('ann-lee'), firstName: 'Ann', company: 'Globex' } })
      await e.engine.tick()
      // Older conversation history is not a reply to this campaign: no check on the first message.
      assert.deepEqual(e.li.callsOf('sendMessage')[0].args, [profile('ann-lee'), 'Hi Ann, quick question about Globex', {}])
      const l = getLead(e.db, lead)
      assert.equal(l.last_action, 'Message sent')
      assert.equal(l.last_message_text, 'Hi Ann, quick question about Globex')
      assert.equal(l.status, 'connected') // only 1st-degree connections can be messaged
      assert.equal(l.connected_at, T0)
      assert.equal(l.current_step_id, 's2')
      assert.equal(l.next_action_at, T0 + 2 * HOUR)
      const [a] = activities(e.db, user)
      assert.deepEqual([a.type, a.status, a.detail], ['message', 'success', 'Message sent'])
    }
  })

  it('later messages stop on a reply written after the previous message (stopOnReply only)', async () => {
    const twoMessages = linear(
      { kind: 'message', config: { message: 'Hi {{first_name}}' } },
      { kind: 'message', delay: { min: 1, max: 1, unit: 'days' }, config: { message: 'Following up, {{first_name}}' } },
    )
    for (const stopOnReply of [true, false]) {
      const { e, lead } = one(twoMessages, { settings: { stopOnReply }, lead: { profileUrl: profile('ann-lee'), firstName: 'Ann' } })
      await e.engine.tick()
      e.setNow(T0 + DAY)
      await e.engine.tick()
      const calls = e.li.callsOf('sendMessage').map((c) => c.args)
      assert.deepEqual(calls, [
        [profile('ann-lee'), 'Hi Ann', {}],
        [profile('ann-lee'), 'Following up, Ann', stopOnReply ? { stopIfRepliedAfter: { after: 'Hi Ann' } } : {}],
      ])
      assert.equal(getLead(e.db, lead).last_message_text, 'Following up, Ann')
      assert.equal(getLead(e.db, lead).status, 'finished')
    }
  })

  it('a delivered message to an invited lead records the acceptance (Accepted / Pending invites stay right)', async () => {
    const { e, user, lead } = one(linear('invite', { kind: 'message', delay: { min: 2, max: 2, unit: 'days' } }, { kind: 'message', delay: { min: 3, max: 3, unit: 'days' } }))
    await e.engine.tick()
    assert.equal(getLead(e.db, lead).status, 'invited')
    e.setNow(T0 + 2 * DAY)
    await e.engine.tick()
    const l = getLead(e.db, lead)
    assert.deepEqual([l.status, l.invited_at, l.connected_at, l.current_step_id], ['connected', T0, T0 + 2 * DAY, 's3'])
    assert.deepEqual(
      activities(e.db, user).map((a) => [a.type, a.status, a.detail]),
      [
        ['invite', 'success', 'Invite sent without a note'],
        ['accepted', 'success', 'Accepted the invite'],
        ['message', 'success', 'Message sent'],
      ],
    )
  })

  it('already_sent (an earlier attempt was delivered) counts as sent', async () => {
    const { e, user, lead } = one(msgThenFollow('Hello {{first_name}}'), { lead: { profileUrl: profile('ann-lee'), firstName: 'Ann' } })
    run(e.db, `UPDATE leads SET status = 'invited', invited_at = ? WHERE id = ?`, T0 - DAY, lead)
    e.li.queue('sendMessage', 'already_sent')
    await e.engine.tick()
    const l = getLead(e.db, lead)
    assert.deepEqual(
      [l.status, l.connected_at, l.last_message_text, l.last_action, l.current_step_id, l.attempts],
      ['connected', T0, 'Hello Ann', 'Message sent', 's2', 0],
    )
    assert.deepEqual(
      activities(e.db, user).map((a) => [a.type, a.status, a.detail]),
      [
        ['accepted', 'success', 'Accepted the invite'],
        ['message', 'success', 'Message was already delivered by an earlier attempt'],
      ],
    )
  })

  it('a retry after an unconfirmed send passes exactly the same text, so the driver can recognise it as delivered', async () => {
    const { e, user, lead } = one(msgThenFollow('Hi {{first_name}} at {{company}}'), { lead: 'mjohnson' })
    e.li.queue('viewProfile', { firstName: 'Mike', lastName: 'Johnson', headline: 'CTO', company: 'Initech', location: 'Pune', profileUrl: profile('mjohnson'), connection: 'connected' })
    e.li.queue('sendMessage', linkedInError('unknown', 'LinkedIn did not confirm the message was sent'), 'already_sent')
    await e.engine.tick()
    let l = getLead(e.db, lead)
    assert.deepEqual([l.attempts, l.first_name, l.company], [1, 'Mike', 'Initech']) // what personalisation read is kept
    e.setNow(l.next_action_at!)
    await e.engine.tick()
    assert.deepEqual(
      e.li.callsOf('sendMessage').map((c) => c.args[1]),
      ['Hi Mike at Initech', 'Hi Mike at Initech'],
    )
    assert.equal(e.li.callsOf('viewProfile').length, 1) // not read again for the retry
    l = getLead(e.db, lead)
    assert.deepEqual([l.attempts, l.error, l.current_step_id, l.last_message_text], [0, null, 's2', 'Hi Mike at Initech'])
    assert.deepEqual(
      activities(e.db, user).map((a) => [a.type, a.status]),
      [
        ['message', 'failed'],
        ['message', 'success'],
      ],
    )
  })

  it('a send cut off by shutdown is retried after restart with the same text (no attempt counted)', async () => {
    const { e, user, lead } = one(msgThenFollow('Hello {{first_name}}'), { lead: { profileUrl: profile('ann-lee'), firstName: 'Ann' } })
    const d = deferred<unknown>()
    e.li.queue('sendMessage', d.promise, 'already_sent')
    const tick = e.engine.tick()
    await until(() => e.li.calls.length === 1, 'sendMessage')
    e.engine.stop()
    d.resolve(linkedInError('unknown', 'Target page, context or browser has been closed'))
    await tick
    let l = getLead(e.db, lead)
    assert.deepEqual([l.attempts, l.current_step_id, l.status, l.last_action_at], [0, 's1', 'queued', null])
    assert.equal(activities(e.db, user).length, 0)

    await e.tickAfterGap() // "restart"
    assert.deepEqual(e.li.callsOf('sendMessage').map((c) => c.args[1]), ['Hello Ann', 'Hello Ann'])
    l = getLead(e.db, lead)
    assert.deepEqual([l.current_step_id, l.last_message_text], ['s2', 'Hello Ann'])
    assert.deepEqual(activities(e.db, user).map((a) => [a.type, a.status, a.detail]), [['message', 'success', 'Message was already delivered by an earlier attempt']])
  })

  it('replied → status replied, replied_at, and with stopOnReply the lead is finished', async () => {
    const { e, user, lead } = one(msgThenFollow())
    run(e.db, `UPDATE leads SET last_message_text = 'Hi there', last_action_at = ? WHERE id = ?`, T0 - DAY, lead)
    e.li.queue('sendMessage', 'replied')
    await e.engine.tick()
    const l = getLead(e.db, lead)
    assert.equal(l.status, 'replied')
    assert.equal(l.replied_at, T0)
    assert.equal(l.current_step_id, null)
    assert.equal(l.next_action_at, null)
    const [a] = activities(e.db, user)
    assert.deepEqual([a.type, a.status], ['replied', 'success'])
  })

  it('not a connection → skipped "Not a 1st-degree connection" and continues', async () => {
    const { e, user, lead } = one(msgThenFollow())
    e.li.queue('sendMessage', 'not_connected')
    await e.engine.tick()
    const l = getLead(e.db, lead)
    assert.equal(l.current_step_id, 's2')
    assert.equal(l.status, 'in_progress')
    const [a] = activities(e.db, user)
    assert.deepEqual([a.type, a.status, a.detail], ['message', 'skipped', 'Not a 1st-degree connection'])
  })

  it('a message that personalises to nothing is skipped without LinkedIn', async () => {
    const { e, user, lead } = one(msgThenFollow('{{company}}'))
    await e.engine.tick()
    assert.equal(e.li.calls.length, 0)
    assert.equal(getLead(e.db, lead).current_step_id, 's2')
    assert.deepEqual(activities(e.db, user).map((a) => [a.type, a.status]), [['message', 'skipped']])
    assert.equal(account(e.db, user).next_action_at, null) // no LinkedIn → no gap
  })

  it('never logs message text', async () => {
    const { e } = one(msgThenFollow('Top secret pitch for {{first_name}}'))
    await e.engine.tick()
    assert.ok(e.logs.length > 0)
    assert.ok(e.logs.every((l) => !l.includes('secret')), e.logs.join('\n'))
  })
})

describe('engine steps: follow / like / withdraw', () => {
  const cases = [
    ['follow', 'follow', 'followed', 'success', 'Followed'],
    ['follow', 'follow', 'already_following', 'skipped', 'Already following'],
    ['like_post', 'likeLatestPost', 'liked', 'success', 'Liked the latest post'],
    ['like_post', 'likeLatestPost', 'already_liked', 'skipped', 'Latest post already liked'],
    ['like_post', 'likeLatestPost', 'no_posts', 'skipped', 'No posts to like'],
    ['withdraw', 'withdrawInvite', 'withdrawn', 'success', 'Invite withdrawn'],
    ['withdraw', 'withdrawInvite', 'not_pending', 'skipped', 'No pending invite'],
  ] as const
  for (const [kind, method, result, status, detail] of cases) {
    it(`${kind}: ${result} → activity ${status}`, async () => {
      const { e, user, lead } = one(linear(kind, 'view_profile'))
      e.li.queue(method, result)
      await e.engine.tick()
      assert.equal(e.li.callsOf(method).length, 1)
      const [a] = activities(e.db, user)
      assert.deepEqual([a.type, a.status, a.detail], [kind, status, detail])
      assert.equal(getLead(e.db, lead).current_step_id, 's2')
      assert.equal(getLead(e.db, lead).last_action_at, T0)
    })
  }

  it('withdraw never downgrades an invited lead', async () => {
    const { e, lead } = one(linear('withdraw', 'view_profile'))
    run(e.db, `UPDATE leads SET status = 'invited', invited_at = ? WHERE id = ?`, T0 - DAY, lead)
    await e.engine.tick()
    assert.equal(getLead(e.db, lead).status, 'invited')
  })
})

describe('engine steps: conditions', () => {
  const acceptedFlow = (within: Duration = { value: 1, unit: 'days' }) =>
    tree(
      { id: 'c1', kind: 'condition', config: { condition: 'accepted_invite', within }, yes: 'm1', no: 'e1' },
      { id: 'm1', kind: 'message', config: { message: 'Thanks for connecting!' } },
      { id: 'e1', kind: 'end' },
    )

  function invited(sequence = acceptedFlow()) {
    const ctx = one(sequence)
    run(ctx.e.db, `UPDATE leads SET status = 'invited', invited_at = ? WHERE id = ?`, T0 - HOUR, ctx.lead)
    return ctx
  }

  it('accepted → connected_at, "accepted" + condition activities, Yes branch', async () => {
    const { e, user, lead } = invited()
    e.li.queue('getConnectionStatus', 'connected')
    await e.engine.tick()
    const l = getLead(e.db, lead)
    assert.equal(l.status, 'connected')
    assert.equal(l.connected_at, T0)
    assert.equal(l.current_step_id, 'm1')
    assert.equal(l.next_action_at, T0)
    assert.equal(l.last_action, 'Accepted invite: Yes')
    assert.deepEqual(
      activities(e.db, user).map((a) => [a.type, a.status, a.detail]),
      [
        ['accepted', 'success', 'Accepted the invite'],
        ['condition', 'success', 'Accepted invite: Yes'],
      ],
    )
  })

  it('not yet → re-check later without an activity row (but the gap applies)', async () => {
    const { e, user, lead } = invited()
    e.li.queue('getConnectionStatus', 'pending')
    await e.engine.tick()
    const l = getLead(e.db, lead)
    // within 1 day → interval clamp(4 h, 2 min, 4 h) × (0.8 + 0.5 × 0.4) = 4 h
    assert.equal(l.next_action_at, T0 + 4 * HOUR)
    assert.equal(l.step_started_at, T0)
    assert.equal(l.current_step_id, 'c1')
    assert.equal(l.status, 'invited')
    assert.equal(l.last_action_at, null)
    assert.equal(activities(e.db, user).length, 0)
    assert.equal(account(e.db, user).next_action_at, T0 + GAP)
  })

  it('re-checks never go past the timeout, and jitter is ±20 %', async () => {
    const short = invited(acceptedFlow({ value: 5, unit: 'minutes' }))
    short.e.setRand(0)
    await short.e.engine.tick()
    // clamp(50 s, 2 min, 4 h) = 2 min × 0.8 = 96 s
    assert.equal(getLead(short.e.db, short.lead).next_action_at, T0 + 96_000)

    const capped = invited(acceptedFlow({ value: 5, unit: 'minutes' }))
    run(capped.e.db, 'UPDATE leads SET step_started_at = ? WHERE id = ?', T0 - 4 * MIN, capped.lead)
    await capped.e.engine.tick()
    assert.equal(getLead(capped.e.db, capped.lead).next_action_at, T0 + MIN) // started + within
  })

  it('timeout → No branch with an activity; the end step then finishes the lead without LinkedIn', async () => {
    const { e, user, lead } = invited()
    e.li.handle('getConnectionStatus', () => 'pending')
    await e.engine.tick()
    e.setNow(T0 + DAY) // Thursday 10:00
    await e.engine.tick()
    let l = getLead(e.db, lead)
    assert.equal(l.current_step_id, 'e1')
    assert.deepEqual(activities(e.db, user).map((a) => [a.type, a.detail]), [['condition', 'Accepted invite: No']])
    assert.equal(e.li.calls.length, 2)

    e.advance(GAP)
    await e.engine.tick()
    l = getLead(e.db, lead)
    assert.equal(l.status, 'finished')
    assert.equal(l.next_action_at, null)
    assert.equal(l.current_step_id, null)
    assert.equal(e.li.calls.length, 2)
  })

  it('is_connected: a lead that was never invited gets connected_at but no "accepted" activity', async () => {
    const { e, user, lead } = one(
      tree(
        { id: 'c1', kind: 'condition', config: { condition: 'is_connected', within: { value: 1, unit: 'days' } }, yes: 'v1', no: 'i1' },
        { id: 'v1', kind: 'view_profile' },
        { id: 'i1', kind: 'invite', config: { message: '' } },
      ),
    )
    e.li.queue('getConnectionStatus', 'connected')
    await e.engine.tick()
    assert.equal(getLead(e.db, lead).status, 'connected')
    assert.equal(getLead(e.db, lead).current_step_id, 'v1')
    assert.deepEqual(activities(e.db, user).map((a) => a.type), ['condition'])
  })

  const repliedFlow = tree(
    { id: 'c1', kind: 'condition', config: { condition: 'replied', within: { value: 3, unit: 'days' } }, yes: 'f1', no: 'm1' },
    { id: 'f1', kind: 'follow' },
    { id: 'm1', kind: 'message', config: { message: 'Following up' } },
  )

  it('replied asks about replies after the last message this campaign sent (null before any)', async () => {
    const a = one(repliedFlow)
    await a.e.engine.tick()
    assert.deepEqual(a.e.li.callsOf('hasReplied')[0].args, [profile('jane-doe-1234'), { after: null }])
    const b = one(repliedFlow)
    run(b.e.db, `UPDATE leads SET last_message_text = 'Hi Jane, quick question' WHERE id = ?`, b.lead)
    await b.e.engine.tick()
    assert.deepEqual(b.e.li.callsOf('hasReplied')[0].args, [profile('jane-doe-1234'), { after: 'Hi Jane, quick question' }])
  })

  it('replied with stopOnReply → replied, finished instead of the Yes branch', async () => {
    const { e, user, lead } = one(repliedFlow)
    e.li.queue('hasReplied', true)
    await e.engine.tick()
    const l = getLead(e.db, lead)
    assert.equal(l.status, 'replied')
    assert.equal(l.replied_at, T0)
    assert.equal(l.current_step_id, null)
    assert.equal(l.next_action_at, null)
    assert.deepEqual(
      activities(e.db, user).map((a) => [a.type, a.detail]),
      [
        ['replied', 'Replied on LinkedIn'],
        ['condition', 'Replied: Yes'],
      ],
    )
  })

  it('replied without stopOnReply → Yes branch', async () => {
    const { e, lead } = one(repliedFlow, { settings: { stopOnReply: false } })
    e.li.queue('hasReplied', true)
    await e.engine.tick()
    const l = getLead(e.db, lead)
    assert.equal(l.status, 'replied')
    assert.equal(l.current_step_id, 'f1')
  })

  it('a check LinkedIn cannot make counts as "not yet"', async () => {
    const { e, user, lead } = invited()
    e.li.queue('getConnectionStatus', linkedInError('action_unavailable', 'No connection info'))
    await e.engine.tick()
    assert.equal(getLead(e.db, lead).current_step_id, 'c1')
    assert.equal(getLead(e.db, lead).next_action_at, T0 + 4 * HOUR)
    assert.equal(activities(e.db, user).length, 0)
  })
})

describe('engine steps: finishing', () => {
  it('the last step finishes the lead; a replied lead stays replied', async () => {
    const { e, lead } = one(linear('view_profile'))
    await e.engine.tick()
    assert.deepEqual(pick(getLead(e.db, lead)), { status: 'finished', current_step_id: null, next_action_at: null })

    const r = one(linear('follow', 'end'))
    run(r.e.db, `UPDATE leads SET status = 'replied', replied_at = ? WHERE id = ?`, T0 - DAY, r.lead)
    await r.e.engine.tick() // follow, then "end" is due immediately
    await r.e.tickAfterGap()
    assert.deepEqual(pick(getLead(r.e.db, r.lead)), { status: 'replied', current_step_id: null, next_action_at: null })
  })

  it('end steps resolve inline and the engine keeps looking for LinkedIn work in the same tick', async () => {
    const e = setup()
    const user = addUser(e.db)
    const c1 = addCampaign(e.db, user, { sequence: linear('view_profile', 'end') })
    const ending = addLeads(e.db, user, c1, ['a-a', 'b-b', 'c-c'])
    for (const id of ending) run(e.db, `UPDATE leads SET current_step_id = 's2', next_action_at = ? WHERE id = ?`, T0 - HOUR, id)
    const c2 = addCampaign(e.db, user, { sequence: linear('follow') })
    const [worker] = addLeads(e.db, user, c2, ['w-w'])
    await e.engine.tick()
    for (const id of ending) assert.equal(getLead(e.db, id).status, 'finished')
    assert.deepEqual(e.li.calls.map((c) => c.method), ['follow'])
    assert.equal(getLead(e.db, worker).status, 'finished')
  })
})

const pick = (l: { status: string; current_step_id: string | null; next_action_at: number | null }) => ({
  status: l.status,
  current_step_id: l.current_step_id,
  next_action_at: l.next_action_at,
})

describe('engine steps: failures', () => {
  it('session_expired → account expired, session activity, the lead is not penalised', async () => {
    const { e, user, lead } = one(linear('invite'))
    e.li.queue('sendInvite', linkedInError('session_expired', 'LinkedIn signed you out'))
    await e.engine.tick()
    const acc = account(e.db, user)
    assert.equal(acc.status, 'expired')
    assert.equal(acc.last_error, 'LinkedIn signed you out')
    const l = getLead(e.db, lead)
    assert.deepEqual([l.attempts, l.next_action_at, l.status, l.error], [0, T0, 'queued', null])
    const [a] = activities(e.db, user)
    assert.deepEqual([a.type, a.status, a.detail, a.lead_id], ['session', 'failed', 'LinkedIn signed you out', null])

    await e.tickAfterGap()
    assert.equal(e.li.sessions.length, 1) // skipped until reconnected
    run(e.db, `UPDATE linkedin_accounts SET status = 'connected' WHERE user_id = ?`, user)
    await e.engine.tick()
    assert.equal(getLead(e.db, lead).invited_at, T0 + GAP)
  })

  it('session_expired raised by withDriver itself is handled the same way', async () => {
    const { e, user, lead } = one(linear('invite'))
    e.li.expired.add(user)
    await e.engine.tick()
    assert.equal(account(e.db, user).status, 'expired')
    assert.equal(getLead(e.db, lead).attempts, 0)
    assert.equal(e.li.calls.length, 0)
  })

  it('a disconnect during the action is not turned into "expired"', async () => {
    const { e, user } = one(linear('invite'))
    e.li.queue('sendInvite', () => {
      run(e.db, `UPDATE linkedin_accounts SET status = 'disconnected' WHERE user_id = ?`, user)
      return linkedInError('session_expired', 'Connect your LinkedIn account first.')
    })
    await e.engine.tick()
    assert.equal(account(e.db, user).status, 'disconnected')
    assert.equal(activities(e.db, user).length, 0)
  })

  it('transient → no attempt counted, the whole user backs off 10–20 min, one session activity', async () => {
    const { e, user, lead } = one(linear('message', 'follow'), { lead: { profileUrl: profile('jane-doe-1234'), firstName: 'Jane', lastName: 'Smith' } })
    e.li.handle('sendMessage', () => linkedInError('transient', "Couldn't reach LinkedIn (ERR_INTERNET_DISCONNECTED)"))
    await e.engine.tick()
    const backoff = T0 + 15 * MIN // rand 0.5 → 10 + 5 min
    assert.equal(account(e.db, user).next_action_at, backoff)
    assert.equal(account(e.db, user).status, 'connected')
    let l = getLead(e.db, lead)
    assert.deepEqual([l.attempts, l.status, l.error, l.current_step_id, l.next_action_at], [0, 'queued', null, 's1', backoff])
    assert.deepEqual(
      activities(e.db, user).map((a) => [a.type, a.status, a.detail, a.lead_id]),
      [['session', 'failed', "Couldn't reach LinkedIn (ERR_INTERNET_DISCONNECTED)", null]],
    )

    e.advance(15 * MIN - 1000)
    await e.engine.tick()
    assert.equal(e.li.calls.length, 1) // still backing off
    // A long outage never fails the lead.
    for (let i = 0; i < 10; i++) await e.tickAfterGap()
    l = getLead(e.db, lead)
    assert.deepEqual([l.attempts, l.status, l.current_step_id], [0, 'queued', 's1'])
    assert.equal(e.li.callsOf('sendMessage').length, 11)

    e.li.handle('sendMessage', () => 'sent')
    await e.tickAfterGap()
    l = getLead(e.db, lead)
    assert.deepEqual([l.attempts, l.status, l.current_step_id], [0, 'connected', 's2'])
    assert.deepEqual(e.errors, [])
  })

  it('transient on one lead lets the other due leads go first', async () => {
    const e = setup()
    const user = addUser(e.db)
    const c = addCampaign(e.db, user, { sequence: linear('view_profile') })
    const [a, b] = addLeads(e.db, user, c, ['a-a', 'b-b'])
    run(e.db, 'UPDATE leads SET next_action_at = ? WHERE id = ?', T0 - HOUR, a)
    e.li.handle('viewProfile', (url: string) =>
      url === profile('a-a')
        ? linkedInError('transient', 'Navigation timeout')
        : { firstName: 'B', lastName: 'B', headline: '', company: '', location: '', profileUrl: url, connection: 'not_connected' },
    )
    await e.engine.tick()
    await e.tickAfterGap()
    assert.deepEqual(e.li.calls.map((x) => x.args[0]), [profile('a-a'), profile('b-b')])
    assert.equal(getLead(e.db, b).status, 'finished')
    assert.equal(getLead(e.db, a).attempts, 0)
  })

  it('account_problem → account status error with the message, session activity, lead untouched; resumes once reconnected', async () => {
    const { e, user, lead } = one(linear('invite'))
    e.li.queue('sendInvite', linkedInError('account_problem', 'Switch your LinkedIn interface language to English'))
    await e.engine.tick()
    const acc = account(e.db, user)
    assert.deepEqual([acc.status, acc.last_error], ['error', 'Switch your LinkedIn interface language to English'])
    const l = getLead(e.db, lead)
    assert.deepEqual([l.attempts, l.next_action_at, l.status, l.error, l.last_action_at], [0, T0, 'queued', null, null])
    assert.deepEqual(
      activities(e.db, user).map((a) => [a.type, a.status, a.detail, a.lead_id]),
      [['session', 'failed', 'Switch your LinkedIn interface language to English', null]],
    )
    assert.equal(e.engine.nextActionAt(user), null)

    await e.tickAfterGap()
    e.advance(DAY)
    await e.engine.tick()
    assert.equal(e.li.sessions.length, 1) // skipped like an expired account
    run(e.db, `UPDATE linkedin_accounts SET status = 'connected' WHERE user_id = ?`, user)
    await e.engine.tick()
    assert.equal(e.li.callsOf('sendInvite').length, 2)
    assert.equal(getLead(e.db, lead).invited_at, e.now())
  })

  it('account_problem does not override an account the user disconnected meanwhile', async () => {
    const { e, user } = one(linear('invite'))
    e.li.queue('sendInvite', () => {
      run(e.db, `UPDATE linkedin_accounts SET status = 'disconnected' WHERE user_id = ?`, user)
      return linkedInError('account_problem', 'Account restricted')
    })
    await e.engine.tick()
    assert.equal(account(e.db, user).status, 'disconnected')
    assert.equal(activities(e.db, user).length, 0)
  })

  it('not_found → lead failed "Profile not found"', async () => {
    const { e, user, lead } = one(linear('view_profile', 'invite'))
    e.li.queue('viewProfile', linkedInError('not_found', 'This page does not exist'))
    await e.engine.tick()
    const l = getLead(e.db, lead)
    assert.deepEqual([l.status, l.error, l.next_action_at], ['failed', 'Profile not found', null])
    const [a] = activities(e.db, user)
    assert.deepEqual([a.type, a.status, a.detail], ['view_profile', 'failed', 'Profile not found'])
  })

  it('action_unavailable → skipped with the message, advances', async () => {
    const { e, user, lead } = one(linear('follow', { kind: 'view_profile', delay: { min: 1, max: 1, unit: 'hours' } }))
    e.li.queue('follow', linkedInError('action_unavailable', 'No Follow button on this profile'))
    await e.engine.tick()
    const l = getLead(e.db, lead)
    assert.equal(l.current_step_id, 's2')
    assert.equal(l.next_action_at, T0 + HOUR)
    assert.equal(l.attempts, 0)
    const [a] = activities(e.db, user)
    assert.deepEqual([a.type, a.status, a.detail], ['follow', 'skipped', 'No Follow button on this profile'])
  })

  it('rate_limited → failed activity, lead postponed to the next day window; same-kind leads wait without LinkedIn', async () => {
    const e = setup()
    const user = addUser(e.db)
    const c = addCampaign(e.db, user, { sequence: linear('invite') })
    const [a, b] = addLeads(e.db, user, c, ['a-a', 'b-b'])
    const c2 = addCampaign(e.db, user, { sequence: linear('view_profile') })
    const [v] = addLeads(e.db, user, c2, ['v-v'], T0 + 1000)
    e.li.queue('sendInvite', linkedInError('rate_limited', 'Weekly invitation limit reached'))
    await e.engine.tick()
    let l = getLead(e.db, a)
    assert.equal(l.next_action_at, THU_9)
    assert.equal(l.error, 'Weekly invitation limit reached')
    assert.equal(l.attempts, 0)
    assert.deepEqual(activities(e.db, user).map((x) => [x.type, x.status, x.detail]), [['invite', 'failed', 'Weekly invitation limit reached']])

    e.advance(HOUR)
    await e.engine.tick()
    assert.equal(e.li.callsOf('sendInvite').length, 1) // b was postponed, not attempted
    assert.equal(getLead(e.db, b).next_action_at, THU_9)
    assert.equal(e.li.callsOf('viewProfile').length, 1)
    assert.equal(getLead(e.db, v).status, 'finished')

    e.setNow(THU_9)
    await e.engine.tick()
    assert.equal(e.li.callsOf('sendInvite').length, 2)
    l = getLead(e.db, a)
    assert.equal(l.invited_at, THU_9)
    assert.equal(l.error, null)
  })

  it('other errors retry with backoff and fail the lead after 3 attempts', async () => {
    const { e, user, lead } = one(linear('message'))
    e.li.handle('sendMessage', () => linkedInError('unknown', 'Timeout waiting for the message box'))
    await e.engine.tick()
    let l = getLead(e.db, lead)
    assert.deepEqual([l.attempts, l.next_action_at, l.error, l.status], [1, T0 + 22.5 * MIN, 'Timeout waiting for the message box', 'queued'])

    e.setNow(l.next_action_at!)
    await e.engine.tick()
    l = getLead(e.db, lead)
    assert.deepEqual([l.attempts, l.next_action_at], [2, T0 + 22.5 * MIN + 45 * MIN])

    e.setNow(l.next_action_at!)
    await e.engine.tick()
    l = getLead(e.db, lead)
    assert.deepEqual([l.attempts, l.next_action_at, l.status, l.error], [3, null, 'failed', 'Timeout waiting for the message box'])
    assert.deepEqual(
      activities(e.db, user).map((a) => [a.type, a.status]),
      [
        ['message', 'failed'],
        ['message', 'failed'],
        ['message', 'failed'],
      ],
    )
  })

  it('unexpected exceptions and malformed driver results count as errors', async () => {
    const { e, lead } = one(linear('follow', 'like_post'))
    e.li.queue('follow', () => new TypeError('page.click is not a function'))
    await e.engine.tick()
    assert.equal(getLead(e.db, lead).attempts, 1)

    e.setNow(getLead(e.db, lead).next_action_at!)
    e.li.queue('follow', undefined)
    await e.engine.tick()
    assert.equal(getLead(e.db, lead).attempts, 2)
    assert.equal(getLead(e.db, lead).error, 'Unexpected response from the LinkedIn driver')

    e.setNow(getLead(e.db, lead).next_action_at!)
    await e.engine.tick()
    assert.equal(getLead(e.db, lead).current_step_id, 's2') // success resets attempts and moves on
    assert.equal(getLead(e.db, lead).attempts, 0)
    assert.equal(e.errors.length, 0)
  })

  it('a success after a failure clears the error', async () => {
    const { e, lead } = one(linear('invite', { kind: 'follow', delay: { min: 1, max: 1, unit: 'days' } }))
    e.li.queue('sendInvite', linkedInError('unknown', 'flaky'))
    await e.engine.tick()
    e.setNow(getLead(e.db, lead).next_action_at!)
    await e.engine.tick()
    const l = getLead(e.db, lead)
    assert.deepEqual([l.error, l.attempts, l.status], [null, 0, 'invited'])
  })
})

describe('engine steps: changes while an action runs', () => {
  it('a lead deleted during the action does not crash; the activity keeps the name', async () => {
    const { e, user, lead } = one(linear('invite', 'follow'))
    const d = deferred<string>()
    e.li.queue('sendInvite', d.promise)
    const tick = e.engine.tick()
    await until(() => e.li.calls.length === 1, 'sendInvite')
    run(e.db, 'DELETE FROM leads WHERE id = ?', lead)
    d.resolve('sent')
    await tick
    assert.deepEqual(e.errors, [])
    const [a] = activities(e.db, user)
    assert.deepEqual([a.type, a.status, a.lead_id, a.lead_name], ['invite', 'success', null, 'Jane Doe'])
    assert.equal(account(e.db, user).next_action_at, T0 + GAP)
  })

  it('a campaign deleted during the action does not crash', async () => {
    const { e, user, campaign } = one(linear('message'))
    const d = deferred<unknown>()
    e.li.queue('sendMessage', d.promise)
    const tick = e.engine.tick()
    await until(() => e.li.calls.length === 1, 'sendMessage')
    run(e.db, 'DELETE FROM campaigns WHERE id = ?', campaign)
    d.resolve(linkedInError('unknown', 'boom'))
    await tick
    assert.deepEqual(e.errors, [])
    const [a] = activities(e.db, user)
    assert.deepEqual([a.campaign_id, a.campaign_name, a.lead_id], [null, 'Q4 Outreach', null])
  })

  it('a campaign paused during the action still records the result; the lead then waits', async () => {
    const { e, campaign, lead } = one(linear('invite', 'follow'))
    const d = deferred<string>()
    e.li.queue('sendInvite', d.promise)
    const tick = e.engine.tick()
    await until(() => e.li.calls.length === 1, 'sendInvite')
    run(e.db, `UPDATE campaigns SET status = 'paused' WHERE id = ?`, campaign)
    d.resolve('sent')
    await tick
    assert.equal(getLead(e.db, lead).status, 'invited')
    assert.equal(getLead(e.db, lead).current_step_id, 's2')
    await e.tickAfterGap()
    assert.equal(e.li.calls.length, 1)
  })

  it('a user removed during the action does not crash', async () => {
    const { e, user } = one(linear('invite', 'follow'))
    const d = deferred<string>()
    e.li.queue('sendInvite', d.promise)
    const tick = e.engine.tick()
    await until(() => e.li.calls.length === 1, 'sendInvite')
    run(e.db, 'DELETE FROM users WHERE id = ?', user)
    d.resolve('sent')
    await tick
    assert.deepEqual(e.errors, [])
    assert.equal(activities(e.db, user).length, 0)
  })

  it('if saving a result fails, the lead is stopped instead of repeating the action', async () => {
    const { e, lead } = one(linear('message', 'follow'))
    e.db.exec(`CREATE TRIGGER boom BEFORE INSERT ON activities BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
    await e.engine.tick()
    assert.equal(e.errors.length, 1)
    const l = getLead(e.db, lead)
    assert.deepEqual([l.status, l.next_action_at, l.current_step_id], ['failed', null, 's1'])
    assert.match(l.error!, /Internal error/)
    await e.tickAfterGap()
    assert.equal(e.li.callsOf('sendMessage').length, 1)
  })

  it('tolerates malformed delays and condition durations in stored sequences', async () => {
    const build = () =>
      tree(
        { id: 's1', kind: 'view_profile', next: 's2' },
        { id: 's2', kind: 'condition', config: { condition: 'is_connected', within: { value: 1, unit: 'days' } }, yes: 's3' },
        { id: 's3', kind: 'follow' },
      )
    const { e, campaign, lead } = one(build())
    const seq = build()
    ;(seq.steps.s2 as any).delay = { min: 1, max: 2, unit: 'weeks' }
    ;(seq.steps.s2 as any).config.within = { value: 'x', unit: 'days' }
    run(e.db, 'UPDATE campaigns SET sequence_json = ? WHERE id = ?', JSON.stringify(seq), campaign)
    await e.engine.tick()
    assert.deepEqual([getLead(e.db, lead).current_step_id, getLead(e.db, lead).next_action_at], ['s2', T0])
    await e.tickAfterGap()
    // not connected yet; default 7 days → re-check in clamp(7d / 6, 2 min, 4 h) = 4 h
    assert.equal(getLead(e.db, lead).next_action_at, T0 + GAP + 4 * HOUR)
    assert.deepEqual(e.errors, [])
  })

  /** Pause, replace the running root step, reconcile (what PATCH /campaigns/:id does) while the step runs. */
  async function editWhileRunning(e: ReturnType<typeof one>['e'], campaign: string, method: 'sendMessage' | 'getConnectionStatus', edited: ReturnType<typeof tree>, result: unknown) {
    const d = deferred<unknown>()
    e.li.queue(method, d.promise)
    const tick = e.engine.tick()
    await until(() => e.li.calls.length === 1, method)
    run(e.db, `UPDATE campaigns SET status = 'paused', sequence_json = ? WHERE id = ?`, JSON.stringify(edited), campaign)
    reconcileLeads(e.db, campaign, edited, e.now(), () => 0.5)
    d.resolve(result)
    await tick
    run(e.db, `UPDATE campaigns SET status = 'active' WHERE id = ?`, campaign)
  }

  it('a step removed by a sequence edit while it ran: the re-rooted lead is not sent the new root as well', async () => {
    const { e, user, campaign, lead } = one(tree({ id: 'm1', kind: 'message', config: { message: 'Hi {{first_name}}, old text' } }), {
      lead: { profileUrl: profile('jane-doe-1234'), firstName: 'Jane', lastName: 'Smith' },
    })
    await editWhileRunning(e, campaign, 'sendMessage', tree({ id: 'm2', kind: 'message', config: { message: 'Hi {{first_name}}, corrected text' } }), 'sent')
    const l = getLead(e.db, lead)
    assert.deepEqual([l.status, l.current_step_id, l.next_action_at, l.last_message_text], ['finished', null, null, 'Hi Jane, old text'])
    for (let i = 0; i < 3; i++) await e.tickAfterGap()
    assert.deepEqual(e.li.callsOf('sendMessage').map((c) => c.args[1]), ['Hi Jane, old text'])
    assert.deepEqual(activities(e.db, user).map((a) => [a.type, a.status]), [['message', 'success']])
  })

  it('…and it continues after the removed step when that next step is still in the sequence', async () => {
    const before = tree(
      { id: 'm1', kind: 'message', config: { message: 'Old text' }, next: 'f1' },
      { id: 'f1', kind: 'follow', delay: { min: 1, max: 1, unit: 'days' } },
    )
    const after = tree(
      { id: 'm2', kind: 'message', config: { message: 'Corrected text' }, next: 'f1' },
      { id: 'f1', kind: 'follow', delay: { min: 1, max: 1, unit: 'days' } },
    )
    const { e, campaign, lead } = one(before)
    await editWhileRunning(e, campaign, 'sendMessage', after, 'sent')
    const l = getLead(e.db, lead)
    assert.deepEqual([l.current_step_id, l.next_action_at, l.status], ['f1', T0 + DAY, 'connected'])
  })

  it('…but a failed step leaves the re-rooted lead at the new root, and a condition that is "not yet" too', async () => {
    const failed = one(tree({ id: 'm1', kind: 'message', config: { message: 'Old' } }))
    const newRoot = tree({ id: 'm2', kind: 'message', config: { message: 'New' } })
    await editWhileRunning(failed.e, failed.campaign, 'sendMessage', newRoot, linkedInError('unknown', 'Composer did not open'))
    let l = getLead(failed.e.db, failed.lead)
    assert.deepEqual([l.current_step_id, l.next_action_at, l.attempts, l.status, l.last_action_at], ['m2', T0, 0, 'queued', null])

    const cond = one(tree({ id: 'c1', kind: 'condition', config: { condition: 'is_connected', within: { value: 7, unit: 'days' } } }))
    await editWhileRunning(cond.e, cond.campaign, 'getConnectionStatus', newRoot, 'not_connected')
    l = getLead(cond.e.db, cond.lead)
    assert.deepEqual([l.current_step_id, l.next_action_at, l.status], ['m2', T0, 'queued'])
  })

  it('a lead moved by a sequence edit during the action keeps its new step', async () => {
    const { e, lead } = one(linear('invite', 'follow', 'like_post'))
    const d = deferred<string>()
    e.li.queue('sendInvite', d.promise)
    const tick = e.engine.tick()
    await until(() => e.li.calls.length === 1, 'sendInvite')
    run(e.db, `UPDATE leads SET current_step_id = 's3', next_action_at = ? WHERE id = ?`, T0 + DAY, lead)
    d.resolve('sent')
    await tick
    const l = getLead(e.db, lead)
    assert.deepEqual([l.current_step_id, l.next_action_at, l.status, l.invited_at], ['s3', T0 + DAY, 'invited', T0])
  })
})
