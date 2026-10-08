/**
 * Lead steps: the LinkedIn call for a step (performStep), and writing its result (applyOutcome) or
 * failure (applyFailure) back to the database. Writes always re-read the lead and campaign first:
 * either may have been paused, edited or deleted while the browser was busy.
 */
import type { ActivityType, ConditionKind, LeadStatus, SequenceStep, StepKind } from '../../../shared/types.ts'
import {
  DEFAULT_CONDITION_WITHIN,
  INVITE_NOTE_LIMIT,
  MESSAGE_LIMIT,
  durationToMs,
  nextStepId,
  pickDelayMs,
  renderTemplate,
} from '../../../shared/sequence.ts'
import { nameFromPublicId } from '../../../shared/linkedin-url.ts'
import { run, tx } from '../db/index.ts'
import {
  type ConnectionStatus,
  type InviteResult,
  LinkedInError,
  type LinkedInDriver,
  type MessageResult,
  type ProfileData,
  type ReplyCheck,
} from '../linkedin/types.ts'
import { type EngineCtx, accountProblem, errorCode, errorText, logText, sessionExpired, tag, transientFailure } from './context.ts'
import { MAX_ATTEMPTS, nextDayWindow, recheckAt, retryAt } from './schedule.ts'
import {
  type ActivityInput,
  type CampaignData,
  type LeadPatch,
  type LeadRow,
  TERMINAL_SQL,
  addActivity,
  isTerminal,
  leadName,
  raiseStatus,
  readCampaign,
  readLead,
  readUserSettings,
  updateLead,
} from './store.ts'

export interface LeadUnit {
  type: 'lead'
  userId: string
  lead: LeadRow
  campaign: CampaignData
  step: SequenceStep
  /** Personalised message text, or invite note (null = no note). */
  text: string | null
  /** The profile performStep read to personalise the text (kept so a failed attempt still saves it). */
  profile?: ProfileData
}

export type StepOutcome =
  | { kind: 'view_profile'; profile: ProfileData }
  | { kind: 'follow'; result: 'followed' | 'already_following' }
  | { kind: 'like_post'; result: 'liked' | 'already_liked' | 'no_posts' }
  | { kind: 'invite'; result: InviteResult; withNote: boolean; noteShortened: boolean; profile?: ProfileData }
  /** text: the message as sent (stored as the lead's last_message_text when delivered) */
  | { kind: 'message'; result: MessageResult; text: string; profile?: ProfileData }
  | { kind: 'withdraw'; result: 'withdrawn' | 'not_pending' }
  | { kind: 'condition'; value: boolean }

export const LINKEDIN_STEPS: readonly StepKind[] = ['view_profile', 'follow', 'like_post', 'invite', 'message', 'withdraw', 'condition']

const STEP_LABEL: Record<StepKind, string> = {
  view_profile: 'View profile',
  follow: 'Follow',
  like_post: 'Like post',
  invite: 'Invite',
  message: 'Message',
  withdraw: 'Withdraw invite',
  condition: 'Condition',
  end: 'End',
}

const QUESTION: Record<ConditionKind, string> = {
  accepted_invite: 'Accepted invite',
  is_connected: 'Is connected',
  replied: 'Replied',
}

const conditionOf = (step: SequenceStep): ConditionKind => step.config?.condition ?? 'accepted_invite'

/** The step's random delay; 0 for a missing step or a malformed delay (sequences are validated, stored JSON may not be). */
function delayMs(step: SequenceStep | undefined, rand: () => number) {
  const ms = step?.delay ? pickDelayMs(step.delay, rand) : 0
  return Number.isFinite(ms) && ms > 0 ? ms : 0
}

/** How long a condition keeps checking; the default for a malformed value. */
function withinMs(step: SequenceStep) {
  const ms = step.config?.within ? durationToMs(step.config.within) : NaN
  return Number.isFinite(ms) && ms > 0 ? ms : durationToMs(DEFAULT_CONDITION_WITHIN)
}

const clip = (s: string | undefined, n: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

/** Shorten to `n` characters, preferably at a word boundary. */
function clipText(s: string, n: number) {
  if (s.length <= n) return s
  const cut = s.slice(0, n)
  const space = cut.search(/\s\S*$/)
  return (space > n * 0.6 ? cut.slice(0, space) : cut).trimEnd()
}

const templateVars = (l: LeadRow) => ({
  first_name: l.first_name,
  last_name: l.last_name,
  company: l.company,
  title: l.headline,
  location: l.location,
})

/**
 * The personalised invite note / message for a step (null when there is none, or it renders empty),
 * clipped to LinkedIn's limit; `shortened` says whether clipping was needed. A pure function of the
 * step and the lead's fields, so a retry sends exactly the same text (the driver's idempotency
 * check relies on that).
 */
export function renderStep(step: SequenceStep, lead: LeadRow): { text: string | null; shortened: boolean } {
  if (step.kind !== 'invite' && step.kind !== 'message') return { text: null, shortened: false }
  const raw = step.config?.message ?? ''
  const text = raw.trim() ? renderTemplate(raw, templateVars(lead)) : ''
  if (!text) return { text: null, shortened: false }
  const clipped = clipText(text, step.kind === 'invite' ? INVITE_NOTE_LIMIT : MESSAGE_LIMIT)
  return { text: clipped, shortened: clipped !== text }
}

/** The personalised invite note / message for a step; null when there is none (or it renders empty). */
export const stepText = (step: SequenceStep, lead: LeadRow): string | null => renderStep(step, lead).text

/** True when the lead's name is missing or was only guessed from the profile URL. */
function nameIsGuessed(l: LeadRow) {
  const guess = nameFromPublicId(l.public_id)
  return !l.first_name.trim() || (l.first_name === guess.firstName && l.last_name === guess.lastName)
}

/** Lead fields a viewed profile should fill: empty ones, and the name when it was guessed from the URL. */
function profilePatch(l: LeadRow, p: ProfileData): Partial<LeadRow> {
  const patch: Partial<LeadRow> = {}
  const first = clip(p.firstName, 100)
  const last = clip(p.lastName, 100)
  if (nameIsGuessed(l) && first) Object.assign(patch, { first_name: first, last_name: last })
  else if (!l.last_name.trim() && last) patch.last_name = last
  if (!l.headline.trim() && clip(p.headline, 300)) patch.headline = clip(p.headline, 300)
  if (!l.company.trim() && clip(p.company, 200)) patch.company = clip(p.company, 200)
  if (!l.location.trim() && clip(p.location, 200)) patch.location = clip(p.location, 200)
  return patch
}

/**
 * Whether an invite/message needs the profile read first: its text uses a variable whose value
 * is missing, or uses the name while the name is only a guess from the URL ("Mjohnson Member").
 */
export function needsProfileForText(step: SequenceStep, l: LeadRow) {
  if (step.kind !== 'invite' && step.kind !== 'message') return false
  const used = new Set([...(step.config?.message ?? '').matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))
  if ((used.has('first_name') || used.has('last_name')) && nameIsGuessed(l)) return true
  return (used.has('company') && !l.company.trim()) || (used.has('title') && !l.headline.trim()) || (used.has('location') && !l.location.trim())
}

function expect<T extends string>(value: T, allowed: readonly T[]): T {
  if (!allowed.includes(value)) throw new LinkedInError('unknown', 'Unexpected response from the LinkedIn driver')
  return value
}

/** Read the profile first when the text needs data the lead doesn't have yet, then render the text. */
async function personalise(d: LinkedInDriver, u: LeadUnit): Promise<{ text: string | null; shortened: boolean; profile?: ProfileData }> {
  if (!needsProfileForText(u.step, u.lead)) return renderStep(u.step, u.lead)
  const profile = await d.viewProfile(u.lead.profile_url)
  if (!profile || typeof profile !== 'object') return renderStep(u.step, u.lead)
  u.profile = profile
  return { ...renderStep(u.step, { ...u.lead, ...profilePatch(u.lead, profile) }), profile }
}

/**
 * What counts as a reply: only what the lead wrote after this campaign's last message to them
 * (null: after our most recent own message in the thread – old history is not a reply).
 */
const replyCheck = (l: LeadRow): ReplyCheck => ({ after: l.last_message_text ?? null })

/**
 * Options for sendMessage: the campaign's first message to a lead is sent without a reply check
 * (there is nothing of ours to reply to yet); later ones stop on a reply when stopOnReply is on.
 */
function messageOptions(u: LeadUnit): { stopIfRepliedAfter?: ReplyCheck } {
  return u.campaign.settings.stopOnReply && u.lead.last_message_text != null ? { stopIfRepliedAfter: replyCheck(u.lead) } : {}
}

/** The one LinkedIn call a step makes (plus a profile read when personalisation needs it). Runs inside withDriver; touches no database state. */
export async function performStep(d: LinkedInDriver, u: LeadUnit): Promise<StepOutcome> {
  const url = u.lead.profile_url
  switch (u.step.kind) {
    case 'view_profile': {
      const profile = await d.viewProfile(url)
      if (!profile || typeof profile !== 'object') throw new LinkedInError('unknown', 'Unexpected response from the LinkedIn driver')
      return { kind: 'view_profile', profile }
    }
    case 'follow':
      return { kind: 'follow', result: expect(await d.follow(url), ['followed', 'already_following']) }
    case 'like_post':
      return { kind: 'like_post', result: expect(await d.likeLatestPost(url), ['liked', 'already_liked', 'no_posts']) }
    case 'invite': {
      const { text, shortened, profile } = await personalise(d, u)
      const result = expect(await d.sendInvite(url, text), ['sent', 'sent_without_note', 'already_connected', 'pending'])
      return { kind: 'invite', result, withNote: text !== null, noteShortened: text !== null && shortened, profile }
    }
    case 'message': {
      const { text, profile } = await personalise(d, u)
      if (!text) throw new LinkedInError('action_unavailable', 'Message is empty after personalisation')
      // Idempotent: a retry after an unconfirmed send passes the same text and gets 'already_sent'.
      const result = await d.sendMessage(url, text, messageOptions(u))
      return { kind: 'message', result: expect(result, ['sent', 'already_sent', 'replied', 'not_connected']), text, profile }
    }
    case 'withdraw':
      return { kind: 'withdraw', result: expect(await d.withdrawInvite(url), ['withdrawn', 'not_pending']) }
    case 'condition': {
      if (conditionOf(u.step) === 'replied') return { kind: 'condition', value: (await d.hasReplied(url, replyCheck(u.lead))) === true }
      const status: ConnectionStatus = await d.getConnectionStatus(url)
      return { kind: 'condition', value: status === 'connected' }
    }
    default:
      throw new LinkedInError('action_unavailable', `Unsupported step "${String(u.step.kind)}"`)
  }
}

/** Collects the changes for one lead, then writes them (and the activities) in one transaction. */
function leadWriter(ctx: EngineCtx, u: LeadUnit, now: number) {
  const fresh = readLead(ctx.db, u.lead.id)
  const campaign = readCampaign(ctx.db, u.campaign.id)
  const lead = fresh ?? u.lead
  const settings = campaign?.settings ?? u.campaign.settings
  // Only advance a lead that is still waiting on this very step (a sequence edit may have moved it).
  const onStep = !!fresh && fresh.current_step_id === u.step.id && !isTerminal(fresh.status)
  // A sequence edit removed this step while it ran. The result was not saved yet, so reconcileLeads
  // took the lead for never acted on and moved it to the new root. The step did run: place the lead
  // as if its result had been saved before the edit (continue after the step where that step still
  // exists, otherwise finish), so the new root is not a second first action (e.g. a second message).
  const rerooted =
    !!fresh && !onStep && !isTerminal(fresh.status) && fresh.last_action_at == null && !!campaign && !campaign.sequence.steps[u.step.id]
  /** Whether this result may move the lead (advance / finish / skip). */
  const moves = onStep || rerooted
  const patch: LeadPatch = {}
  const acts: Omit<ActivityInput, 'leadName'>[] = []
  let status: LeadStatus = lead.status

  const raise = (target: LeadStatus) => {
    status = raiseStatus(status, target)
  }
  const set = (p: LeadPatch) => Object.assign(patch, p)
  const activity = (type: ActivityType, st: ActivityInput['status'], detail: string) =>
    acts.push({
      userId: u.userId,
      campaignId: u.campaign.id,
      campaignName: campaign?.name ?? u.campaign.name,
      leadId: lead.id,
      stepId: u.step.id,
      type,
      status: st,
      detail,
      at: now,
    })
  /** A step ran (successfully or skipped): the common bookkeeping. */
  const executed = (lastAction: string) => {
    raise('in_progress')
    set({ last_action: lastAction, last_action_at: now, error: null, attempts: 0 })
  }
  const connected = () => {
    if (lead.connected_at == null && patch.connected_at == null) {
      set({ connected_at: now })
      if (lead.invited_at != null || patch.invited_at != null) activity('accepted', 'success', 'Accepted the invite')
    }
    raise('connected')
  }
  /** Returns true when this is the first time a reply was detected. */
  const replied = () => {
    raise('replied')
    if (lead.replied_at != null || patch.replied_at != null) return false
    set({ replied_at: now })
    return true
  }
  const finish = () => {
    if (!moves) return
    if (status !== 'replied') status = 'finished'
    set({ current_step_id: null, next_action_at: null })
  }
  /** Take the lead out of the campaign. */
  const skip = () => {
    if (!moves) return
    status = 'skipped'
    set({ current_step_id: null, next_action_at: null })
  }
  const advance = (outcome?: boolean) => {
    if (!moves) return
    const seq = campaign?.sequence ?? u.campaign.sequence
    const nextId = nextStepId(seq.steps[u.step.id] ?? u.step, outcome)
    // A next step that is not in the (edited) sequence: finish, as reconcileLeads does for acted-on leads.
    if (!nextId || !seq.steps[nextId]) return finish()
    const due = now + delayMs(seq.steps[nextId], ctx.rand)
    set({ current_step_id: nextId, next_action_at: due, step_started_at: due })
  }
  const fail = (error: string) => {
    if (!isTerminal(status)) status = 'failed'
    set({ error, next_action_at: null })
  }
  /** "First Last" including name changes made by this step. */
  const name = () => leadName({ ...lead, ...patch })
  const commit = () =>
    tx(ctx.db, () => {
      if (fresh) updateLead(ctx.db, lead.id, status !== fresh.status ? { ...patch, status } : patch)
      for (const a of acts) addActivity(ctx.db, { ...a, leadName: name() || null })
    })

  return { lead, exists: !!fresh, onStep, rerooted, moves, settings, now, name, raise, set, activity, executed, connected, replied, finish, skip, advance, fail, commit }
}

type Writer = ReturnType<typeof leadWriter>

/**
 * skipConnected applies to connections that existed before this campaign reached out: not to a
 * lead this campaign invited (who has now accepted) or is already in conversation with.
 */
const isExistingConnection = (l: LeadRow) => l.invited_at == null && l.last_message_text == null && l.status !== 'replied'

function logUnit(ctx: EngineCtx, u: LeadUnit, w: Writer, result: string) {
  const note = !w.exists ? ' [lead deleted meanwhile]' : w.onStep ? '' : w.rerooted ? ' [step removed meanwhile]' : ' [lead moved meanwhile]'
  ctx.log(`${tag(u.userId)} ${u.step.kind} → ${result} (${w.name() || w.lead.id})${note}`)
}

/** Fill empty (or guessed-from-URL) lead fields from a viewed profile. */
function fillProfile(w: Writer, p: ProfileData) {
  const patch = profilePatch(w.lead, p)
  if (Object.keys(patch).length) w.set(patch)
}

function applyCondition(ctx: EngineCtx, u: LeadUnit, w: Writer, value: boolean): string {
  const kind = conditionOf(u.step)
  const q = QUESTION[kind] ?? 'Condition'
  if (value) {
    let stop = false
    if (kind === 'replied') {
      if (w.replied()) w.activity('replied', 'success', 'Replied on LinkedIn')
      stop = w.settings.stopOnReply
    } else w.connected()
    w.executed(`${q}: Yes`)
    w.activity('condition', 'success', `${q}: Yes`)
    if (stop) w.finish()
    else w.advance(true)
    return stop ? 'yes, replied – finished' : 'yes'
  }
  if (!w.onStep) return 'no'
  const started = w.lead.step_started_at ?? w.now
  const within = withinMs(u.step)
  if (w.now - started >= within) {
    w.executed(`${q}: No`)
    w.activity('condition', 'success', `${q}: No`)
    w.advance(false)
    return 'no'
  }
  // Not yet: check again later, no activity row.
  const at = recheckAt(w.now, started, within, ctx.rand)
  w.raise('in_progress')
  w.set({ next_action_at: at, attempts: 0, error: null, ...(w.lead.step_started_at == null ? { step_started_at: started } : {}) })
  return `not yet, re-check at ${new Date(at).toISOString()}`
}

/** Write the result of a step that LinkedIn completed. */
export function applyOutcome(ctx: EngineCtx, u: LeadUnit, out: StepOutcome) {
  const w = leadWriter(ctx, u, ctx.now())
  let result: string = 'done'
  switch (out.kind) {
    case 'view_profile':
      fillProfile(w, out.profile)
      if (out.profile.connection === 'connected') w.connected()
      w.executed('Viewed profile')
      w.activity('view_profile', 'success', 'Viewed profile')
      w.advance()
      result = `viewed (${out.profile.connection})`
      break
    case 'follow': {
      const ok = out.result === 'followed'
      w.executed(ok ? 'Followed' : 'Already following')
      w.activity('follow', ok ? 'success' : 'skipped', ok ? 'Followed' : 'Already following')
      w.advance()
      result = out.result
      break
    }
    case 'like_post': {
      const detail = { liked: 'Liked the latest post', already_liked: 'Latest post already liked', no_posts: 'No posts to like' }[out.result]
      w.executed(out.result === 'liked' ? 'Liked a post' : detail)
      w.activity('like_post', out.result === 'liked' ? 'success' : 'skipped', detail)
      w.advance()
      result = out.result
      break
    }
    case 'invite':
      if (out.profile) fillProfile(w, out.profile)
      result = out.result
      if (out.result === 'sent' || out.result === 'sent_without_note') {
        w.set({ invited_at: w.now })
        w.raise('invited')
        w.executed('Invite sent')
        w.activity(
          'invite',
          'success',
          out.result === 'sent_without_note'
            ? 'Invite sent without a note (LinkedIn did not allow one)'
            : out.withNote
              ? out.noteShortened
                ? `Invite sent with a note (shortened to ${INVITE_NOTE_LIMIT} characters)`
                : 'Invite sent with a note'
              : 'Invite sent without a note',
        )
      } else if (out.result === 'already_connected') {
        w.connected()
        if (w.settings.skipConnected && w.moves && isExistingConnection(w.lead)) {
          // skipConnected: an existing connection leaves the campaign.
          w.executed('Already a connection – skipped')
          w.activity('invite', 'skipped', 'Already connected – lead skipped')
          w.skip()
          result = 'already_connected, lead skipped'
          break
        }
        w.executed('Already connected')
        w.activity('invite', 'skipped', 'Already connected')
      } else {
        if (w.lead.invited_at == null) w.set({ invited_at: w.now })
        w.raise('invited')
        w.executed('Invite pending')
        w.activity('invite', 'skipped', 'Invite already pending')
      }
      w.advance()
      break
    case 'message':
      if (out.profile) fillProfile(w, out.profile)
      if (out.result === 'sent' || out.result === 'already_sent') {
        // Only 1st-degree connections can be messaged, so a delivered message proves the connection.
        w.connected()
        // Replies only count after this message (see replyCheck); recorded even if the lead moved meanwhile.
        w.set({ last_message_text: out.text })
        w.executed('Message sent')
        w.activity('message', 'success', out.result === 'sent' ? 'Message sent' : 'Message was already delivered by an earlier attempt')
        w.advance()
      } else if (out.result === 'replied') {
        w.replied()
        w.executed('Replied')
        w.activity('replied', 'success', 'Replied on LinkedIn – message not sent')
        if (w.settings.stopOnReply) w.finish()
        else w.advance()
      } else {
        w.executed('Message skipped – not connected')
        w.activity('message', 'skipped', 'Not a 1st-degree connection')
        w.advance()
      }
      result = out.result
      break
    case 'withdraw': {
      const ok = out.result === 'withdrawn'
      w.executed(ok ? 'Invite withdrawn' : 'No pending invite')
      w.activity('withdraw', ok ? 'success' : 'skipped', ok ? 'Invite withdrawn' : 'No pending invite')
      w.advance()
      result = out.result
      break
    }
    case 'condition':
      result = `${conditionOf(u.step)}: ${applyCondition(ctx, u, w, out.value)}`
      break
  }
  w.commit()
  logUnit(ctx, u, w, result)
}

/**
 * Network / browser trouble: no attempt is counted and the lead stays due. It waits until the user's
 * back-off ends, behind leads that were already due, so one lead whose page keeps failing cannot
 * hold up the others.
 */
function applyTransient(ctx: EngineCtx, u: LeadUnit, err: unknown) {
  const until = transientFailure(ctx, u.userId, err)
  const w = leadWriter(ctx, u, ctx.now())
  if (u.profile) fillProfile(w, u.profile)
  if (w.onStep && (w.lead.next_action_at ?? 0) < until) w.set({ next_action_at: until })
  w.commit()
  logUnit(ctx, u, w, `transient failure, no attempt counted – user paused until ${new Date(until).toISOString()}: ${logText(err)}`)
}

/** Write the failure of a step (LinkedInError codes as in docs/ENGINE.md; anything else is "unknown"). */
export function applyFailure(ctx: EngineCtx, u: LeadUnit, err: unknown) {
  const code = errorCode(err)
  // The account, not the lead: the lead is left as it is (still due).
  if (code === 'session_expired') return sessionExpired(ctx, u.userId, err)
  if (code === 'account_problem') return accountProblem(ctx, u.userId, err)
  if (code === 'transient') return applyTransient(ctx, u, err)
  // A check that can't be made counts as "not yet": keep waiting until the condition times out.
  if (code === 'action_unavailable' && u.step.kind === 'condition') return applyOutcome(ctx, u, { kind: 'condition', value: false })

  const w = leadWriter(ctx, u, ctx.now())
  // Keep what personalisation read, so a retry renders the same text without reading the profile again.
  if (u.profile) fillProfile(w, u.profile)
  const type = u.step.kind as ActivityType
  const msg = errorText(err)
  let result: string
  switch (code) {
    case 'rate_limited': {
      const until = nextDayWindow(w.now, readUserSettings(ctx.db, u.userId))
      w.activity(type, 'failed', msg)
      if (w.onStep) w.set({ next_action_at: until, error: msg })
      ctx.throttle(u.userId, u.step.kind, until)
      result = `rate limited, postponed to ${new Date(until).toISOString()}`
      break
    }
    case 'not_found':
      w.activity(type, 'failed', 'Profile not found')
      if (w.exists) w.fail('Profile not found')
      result = 'profile not found – lead failed'
      break
    case 'action_unavailable':
      w.activity(type, 'skipped', msg)
      w.executed(`${STEP_LABEL[u.step.kind] ?? 'Step'} skipped`)
      w.advance()
      result = 'unavailable, skipped'
      break
    default: {
      w.activity(type, 'failed', msg)
      const attempts = w.lead.attempts + 1
      if (!w.onStep) result = 'error'
      else if (attempts >= MAX_ATTEMPTS) {
        w.fail(msg)
        w.set({ attempts })
        result = `error, attempt ${attempts}/${MAX_ATTEMPTS} – lead failed`
      } else {
        w.set({ attempts, error: msg, next_action_at: retryAt(w.now, attempts, ctx.rand) })
        result = `error, attempt ${attempts}/${MAX_ATTEMPTS} – will retry`
      }
    }
  }
  w.commit()
  logUnit(ctx, u, w, `${result}: ${logText(err)}`)
}

/** `end` reached: finish the lead (a replied lead stays "replied"). No LinkedIn call. */
export function finishLeadInline(ctx: EngineCtx, lead: LeadRow) {
  run(
    ctx.db,
    `UPDATE leads SET status = CASE WHEN status = 'replied' THEN 'replied' ELSE 'finished' END,
       current_step_id = NULL, next_action_at = NULL
     WHERE id = ? AND status NOT IN ${TERMINAL_SQL}`,
    lead.id,
  )
  ctx.log(`${tag(lead.user_id)} end → finished (${leadName(lead) || lead.id})`)
}

/**
 * skipOtherCampaigns, right before the lead's first LinkedIn action: another campaign is already
 * contacting this person, so the lead leaves this campaign without any LinkedIn call.
 */
export function skipLeadInline(ctx: EngineCtx, u: LeadUnit, reason: string) {
  const w = leadWriter(ctx, u, ctx.now())
  w.activity(u.step.kind as ActivityType, 'skipped', reason)
  w.set({ last_action: 'Skipped', error: reason })
  w.skip()
  w.commit()
  logUnit(ctx, u, w, 'skipped – already being contacted by another campaign')
}

/**
 * Skip a step without LinkedIn and move on: a message that personalises to nothing (recorded), or a
 * step type this engine does not know (detail null: just advance).
 */
export function skipStepInline(ctx: EngineCtx, u: LeadUnit, detail: string | null) {
  const w = leadWriter(ctx, u, ctx.now())
  if (detail !== null && LINKEDIN_STEPS.includes(u.step.kind)) {
    w.activity(u.step.kind as ActivityType, 'skipped', detail)
    w.executed(`${STEP_LABEL[u.step.kind] ?? 'Step'} skipped`)
  }
  w.advance()
  w.commit()
  logUnit(ctx, u, w, 'skipped')
}
