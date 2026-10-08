/**
 * UI metadata for the sequence builder. The model itself (make / insert / delete / validate)
 * lives in @shared/sequence.ts so the builder and the engine agree.
 */
import type { ActionKind, ConditionKind, Delay, DelayUnit, Duration, Sequence, SequenceStep, StepKind } from '@shared/types.ts'
import { INVITE_NOTE_LIMIT, MAX_DELAY_DAYS, TEMPLATE_VARIABLES, renderTemplate } from '@shared/sequence.ts'

export interface StepMeta {
  label: string
  description: string
  channel: 'linkedin' | 'logic'
}

export const STEP_META: Record<StepKind, StepMeta> = {
  invite: { label: 'Send invite', description: 'Send a connection request, optionally with a personal note (up to 300 characters).', channel: 'linkedin' },
  message: { label: 'Send message', description: 'Send a LinkedIn message. Only reaches 1st-degree connections.', channel: 'linkedin' },
  view_profile: { label: 'View profile', description: 'Visit the lead’s profile so they see you in “Who viewed my profile”.', channel: 'linkedin' },
  follow: { label: 'Follow', description: 'Follow the lead so you show up in their notifications.', channel: 'linkedin' },
  like_post: { label: 'Like latest post', description: 'Like the lead’s most recent post, if they have one.', channel: 'linkedin' },
  withdraw: { label: 'Withdraw invite', description: 'Withdraw a connection request that is still pending.', channel: 'linkedin' },
  condition: { label: 'Condition', description: 'Split the sequence into Yes / No branches.', channel: 'logic' },
  end: { label: 'End', description: 'Stop the sequence for this lead.', channel: 'logic' },
}

export const ACTION_GROUPS: { title: string; kinds: ActionKind[] }[] = [
  { title: 'LinkedIn actions', kinds: ['invite', 'message', 'view_profile', 'follow', 'like_post', 'withdraw'] },
]

export const CONDITION_META: Record<ConditionKind, { label: string; question: string; description: string; yes: string; no: string }> = {
  accepted_invite: {
    label: 'If invite accepted',
    question: 'Accepted your invite?',
    description: 'Wait for the lead to accept your connection request.',
    yes: 'as soon as the lead accepts your invite',
    no: 'if the invite is still not accepted',
  },
  is_connected: {
    label: 'If connected',
    question: 'Is a 1st-degree connection?',
    description: 'Check whether the lead is already one of your connections.',
    yes: 'as soon as the lead is a 1st-degree connection',
    no: 'if the lead is still not connected',
  },
  replied: {
    label: 'If replied',
    question: 'Replied to your message?',
    description: 'Wait for the lead to reply to you on LinkedIn.',
    yes: 'as soon as the lead replies',
    no: 'if there is still no reply',
  },
}

export const CONDITION_ORDER: ConditionKind[] = ['accepted_invite', 'replied', 'is_connected']

/** Example lead used for message previews. */
export const SAMPLE_VARS = {
  first_name: 'Mike',
  last_name: 'Johnson',
  company: 'Acme Corp',
  title: 'Head of Sales',
  location: 'Pune, India',
}

export const DELAY_UNITS: { id: DelayUnit; label: string }[] = [
  { id: 'minutes', label: 'minutes' },
  { id: 'hours', label: 'hours' },
  { id: 'days', label: 'days' },
]

const UNIT_MINUTES: Record<DelayUnit, number> = { minutes: 1, hours: 60, days: 1440 }
const MAX_MINUTES = MAX_DELAY_DAYS * 1440

/** Title shown on a step card (conditions show what they check). */
export function stepTitle(step: Pick<SequenceStep, 'kind' | 'config'>) {
  if (step.kind === 'condition') return CONDITION_META[step.config.condition ?? 'accepted_invite']?.label ?? 'Condition'
  return STEP_META[step.kind]?.label ?? 'Unknown step'
}

/** Step numbers in reading order (depth first, Yes before No) – matches the canvas. */
export function stepNumbers(seq: Sequence): Map<string, number> {
  const out = new Map<string, number>()
  const visit = (id: string | null | undefined) => {
    if (!id || out.has(id) || !seq.steps[id]) return
    out.set(id, out.size + 1)
    const s = seq.steps[id]
    visit(s.next)
    visit(s.yes)
    visit(s.no)
  }
  visit(seq.rootId)
  return out
}

/** Problem with a step's random wait, or null. */
export function delayError(d: Delay): string | null {
  if (![d.min, d.max].every((n) => Number.isFinite(n) && n >= 0)) return 'Enter a number of 0 or more'
  if (d.min > d.max) return 'The minimum can’t be more than the maximum'
  if (d.max * UNIT_MINUTES[d.unit] > MAX_MINUTES) return `The wait can be at most ${MAX_DELAY_DAYS} days`
  return null
}

/** Problem with a condition's waiting time, or null. */
export function withinError(w: Duration | undefined): string | null {
  if (!w || !Number.isFinite(w.value) || w.value <= 0) return 'Enter a waiting time of at least 1'
  if (w.value * UNIT_MINUTES[w.unit] > MAX_MINUTES) return `The waiting time can be at most ${MAX_DELAY_DAYS} days`
  return null
}

/** `{{variable}}` names used in a text that the engine doesn't know. */
export function unknownVariables(text: string, known: readonly string[]) {
  const found = new Set<string>()
  for (const m of text.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) if (!known.includes(m[1])) found.add(m[1])
  return [...found]
}

/** Typical length of each template variable, for estimating how long a personalised text gets. */
export const TYPICAL_VARIABLE_LENGTHS: Record<(typeof TEMPLATE_VARIABLES)[number], number> = {
  first_name: 10,
  last_name: 12,
  company: 25,
  title: 40,
  location: 20,
}

/** Length of `text` once its {{variables}} are filled with values of typical length (rendered like the engine does). */
export function personalisedLength(text: string) {
  const vars = Object.fromEntries(TEMPLATE_VARIABLES.map((v) => [v, 'x'.repeat(TYPICAL_VARIABLE_LENGTHS[v])])) as Record<(typeof TEMPLATE_VARIABLES)[number], string>
  return renderTemplate(text, vars).length
}

/**
 * An invite note that fits the 300-character limit as written but probably not once personalised
 * (the engine then shortens it to 300 characters): its estimated length, else null.
 */
export function inviteNoteOverflow(note: string): number | null {
  if (note.length > INVITE_NOTE_LIMIT) return null // already over as written – that's an error, not a warning
  const n = personalisedLength(note)
  return n > INVITE_NOTE_LIMIT ? n : null
}

/**
 * "If replied" conditions with steps on their Yes branch. With the campaign setting "Stop the sequence
 * when a lead replies" on, a detected reply finishes the lead, so those steps never run.
 * Ids in reading order.
 */
export function repliedYesBranchSteps(seq: Sequence): string[] {
  const order = stepNumbers(seq)
  return Object.values(seq.steps)
    .filter((s) => s.kind === 'condition' && s.config.condition === 'replied' && hasRunnableStep(seq, s.yes))
    .map((s) => s.id)
    .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
}

/** Whether the branch starting at `id` holds anything but a lone End. */
export function hasRunnableStep(seq: Sequence, id: string | null | undefined) {
  const s = id ? seq.steps[id] : undefined
  return !!s && s.kind !== 'end'
}
