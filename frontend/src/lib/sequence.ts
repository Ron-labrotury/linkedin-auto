import type { ActionKind, BranchKey, ConditionKind, Sequence, SequenceStep, StepKind } from '../types'
import { uid } from './utils'

export interface StepMeta {
  label: string
  short: string
  description: string
  channel: 'linkedin' | 'email' | 'logic'
}

export const STEP_META: Record<StepKind, StepMeta> = {
  view_profile: { label: 'View profile', short: 'View', description: 'Visit the lead’s profile so they see you in “Who viewed my profile”.', channel: 'linkedin' },
  follow: { label: 'Follow', short: 'Follow', description: 'Follow the lead to show up in their notifications.', channel: 'linkedin' },
  endorse: { label: 'Endorse skills', short: 'Endorse', description: 'Endorse up to 5 of the lead’s top skills.', channel: 'linkedin' },
  like_post: { label: 'Like latest post', short: 'Like', description: 'Like the lead’s most recent post or article.', channel: 'linkedin' },
  invite: { label: 'Send invite', short: 'Invite', description: 'Send a connection request, optionally with a personal note (300 chars).', channel: 'linkedin' },
  message: { label: 'Send message', short: 'Message', description: 'Send a LinkedIn message. Only reaches 1st-degree connections.', channel: 'linkedin' },
  withdraw: { label: 'Withdraw invite', short: 'Withdraw', description: 'Withdraw a pending connection request that was not accepted.', channel: 'linkedin' },
  find_email: { label: 'Find email', short: 'Find email', description: 'Look up the lead’s business email address.', channel: 'email' },
  email: { label: 'Send email', short: 'Email', description: 'Send an email from your connected mailbox.', channel: 'email' },
  condition: { label: 'Condition', short: 'If', description: 'Split the sequence into Yes / No branches.', channel: 'logic' },
  end: { label: 'End', short: 'End', description: 'Stop the sequence for this lead.', channel: 'logic' },
}

export const ACTION_GROUPS: { title: string; kinds: (ActionKind | 'condition')[] }[] = [
  { title: 'LinkedIn actions', kinds: ['view_profile', 'invite', 'message', 'follow', 'endorse', 'like_post', 'withdraw'] },
  { title: 'Email actions', kinds: ['find_email', 'email'] },
  { title: 'Logic', kinds: ['condition'] },
]

export const CONDITION_META: Record<ConditionKind, { label: string; question: string }> = {
  accepted_invite: { label: 'Invite accepted', question: 'Accepted the invite?' },
  is_connected: { label: 'Is connected', question: 'Already a 1st-degree connection?' },
  replied: { label: 'Replied', question: 'Replied to a message?' },
  has_email: { label: 'Has email', question: 'Email address found?' },
  opened_email: { label: 'Opened email', question: 'Opened the email?' },
}

export const TEMPLATE_VARIABLES = ['first_name', 'last_name', 'company', 'title', 'location'] as const

export const SAMPLE_VARS: Record<string, string> = {
  first_name: 'Mike',
  last_name: 'Johnson',
  company: 'Acme Corp',
  title: 'Head of Sales',
  location: 'Pune, India',
}

export const INVITE_NOTE_LIMIT = 300

export function makeStep(kind: StepKind): SequenceStep {
  const base: SequenceStep = { id: uid('step'), kind, delay: { days: 0, hours: 0 }, config: {} }
  switch (kind) {
    case 'invite':
      return { ...base, config: { message: 'Hi {{first_name}}, I came across your profile and would love to connect.' } }
    case 'message':
      return { ...base, delay: { days: 1, hours: 0 }, config: { message: 'Thanks for connecting, {{first_name}}! ' } }
    case 'email':
      return { ...base, delay: { days: 1, hours: 0 }, config: { subject: 'Quick question, {{first_name}}', message: 'Hi {{first_name}},\n\n' } }
    case 'endorse':
      return { ...base, config: { skillsCount: 3 } }
    case 'condition':
      return { ...base, config: { condition: 'accepted_invite', withinDays: 7 } }
    default:
      return base
  }
}

export const emptySequence = (): Sequence => ({ rootId: null, steps: {} })

export function branchesOf(step: SequenceStep): BranchKey[] {
  if (step.kind === 'end') return []
  return step.kind === 'condition' ? ['yes', 'no'] : ['next']
}

/** Insert a step at `parentId[branch]` (or as root if parentId is null). Existing child is reattached below. */
export function insertStep(seq: Sequence, parentId: string | null, branch: BranchKey, step: SequenceStep): Sequence {
  const steps = { ...seq.steps }
  const existing = parentId ? steps[parentId]?.[branch] ?? null : seq.rootId
  const s: SequenceStep = { ...step }
  if (existing) {
    if (s.kind === 'condition') s.yes = existing
    else if (s.kind !== 'end') s.next = existing
    else {
      // inserting an "end" mid-sequence drops the rest
      removeSubtree(steps, existing)
    }
  }
  steps[s.id] = s
  if (parentId) {
    steps[parentId] = { ...steps[parentId], [branch]: s.id }
    return { ...seq, steps }
  }
  return { rootId: s.id, steps }
}

function removeSubtree(steps: Record<string, SequenceStep>, id: string | null | undefined) {
  if (!id || !steps[id]) return
  const s = steps[id]
  delete steps[id]
  removeSubtree(steps, s.next)
  removeSubtree(steps, s.yes)
  removeSubtree(steps, s.no)
}

export function findParent(seq: Sequence, id: string): { parentId: string | null; branch: BranchKey } | null {
  if (seq.rootId === id) return { parentId: null, branch: 'next' }
  for (const s of Object.values(seq.steps)) {
    for (const b of ['next', 'yes', 'no'] as BranchKey[]) if (s[b] === id) return { parentId: s.id, branch: b }
  }
  return null
}

/** Delete a step. Linear steps are spliced out; conditions remove both branches. */
export function deleteStep(seq: Sequence, id: string): Sequence {
  const target = seq.steps[id]
  if (!target) return seq
  const parent = findParent(seq, id)
  const steps = { ...seq.steps }
  let replacement: string | null = null
  if (target.kind === 'condition') {
    removeSubtree(steps, target.yes)
    removeSubtree(steps, target.no)
  } else {
    replacement = target.next ?? null
  }
  delete steps[id]
  if (!parent) return { ...seq, steps }
  if (parent.parentId === null) return { rootId: replacement, steps }
  steps[parent.parentId] = { ...steps[parent.parentId], [parent.branch]: replacement }
  return { ...seq, steps }
}

export function updateStep(seq: Sequence, id: string, patch: Partial<SequenceStep>): Sequence {
  return { ...seq, steps: { ...seq.steps, [id]: { ...seq.steps[id], ...patch } } }
}

export function countSteps(seq: Sequence) {
  return Object.values(seq.steps).filter((s) => s.kind !== 'end').length
}

export interface ValidationIssue {
  stepId: string
  message: string
}

export function validateSequence(seq: Sequence): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const s of Object.values(seq.steps)) {
    if ((s.kind === 'message' || s.kind === 'email') && !s.config.message?.trim())
      issues.push({ stepId: s.id, message: `${STEP_META[s.kind].label}: message is empty` })
    if (s.kind === 'email' && !s.config.subject?.trim())
      issues.push({ stepId: s.id, message: 'Send email: subject is empty' })
    if (s.kind === 'invite' && (s.config.message?.length ?? 0) > INVITE_NOTE_LIMIT)
      issues.push({ stepId: s.id, message: `Send invite: note exceeds ${INVITE_NOTE_LIMIT} characters` })
  }
  return issues
}

/* ---------- Templates ---------- */

function chain(kinds: (SequenceStep | StepKind)[]): { first: SequenceStep; all: SequenceStep[] } {
  const all = kinds.map((k) => (typeof k === 'string' ? makeStep(k) : k))
  for (let i = 0; i < all.length - 1; i++) all[i].next = all[i + 1].id
  return { first: all[0], all }
}

function toSequence(all: SequenceStep[], rootId: string): Sequence {
  return { rootId, steps: Object.fromEntries(all.map((s) => [s.id, s])) }
}

export interface SequenceTemplate {
  id: string
  name: string
  description: string
  build: () => Sequence
}

export const SEQUENCE_TEMPLATES: SequenceTemplate[] = [
  {
    id: 'blank',
    name: 'Start from scratch',
    description: 'An empty canvas. Add steps one by one.',
    build: emptySequence,
  },
  {
    id: 'connect_follow_up',
    name: 'Connect + follow up',
    description: 'View profile → invite → if accepted, message twice; otherwise withdraw.',
    build: () => {
      const view = makeStep('view_profile')
      const invite = { ...makeStep('invite'), delay: { days: 1, hours: 0 } }
      const cond = makeStep('condition')
      const msg1 = makeStep('message')
      const cond2 = { ...makeStep('condition'), config: { condition: 'replied' as const, withinDays: 3 } }
      const msg2 = { ...makeStep('message'), delay: { days: 0, hours: 0 }, config: { message: 'Hi {{first_name}}, just bumping this up in case it got buried.' } }
      const endReplied = makeStep('end')
      const withdraw = makeStep('withdraw')
      view.next = invite.id
      invite.next = cond.id
      cond.yes = msg1.id
      cond.no = withdraw.id
      msg1.next = cond2.id
      cond2.yes = endReplied.id
      cond2.no = msg2.id
      return toSequence([view, invite, cond, msg1, cond2, msg2, endReplied, withdraw], view.id)
    },
  },
  {
    id: 'warm_up',
    name: 'Warm up, then connect',
    description: 'View → follow → endorse → like a post → invite with note.',
    build: () => {
      const { first, all } = chain([
        'view_profile',
        { ...makeStep('follow'), delay: { days: 1, hours: 0 } },
        { ...makeStep('endorse'), delay: { days: 1, hours: 0 } },
        { ...makeStep('like_post'), delay: { days: 1, hours: 0 } },
        { ...makeStep('invite'), delay: { days: 1, hours: 0 } },
      ])
      return toSequence(all, first.id)
    },
  },
  {
    id: 'multichannel',
    name: 'LinkedIn + email',
    description: 'Invite; if not accepted in 7 days, find their email and send an email instead.',
    build: () => {
      const view = makeStep('view_profile')
      const invite = makeStep('invite')
      const cond = makeStep('condition')
      const msg = makeStep('message')
      const find = makeStep('find_email')
      const hasEmail = { ...makeStep('condition'), config: { condition: 'has_email' as const, withinDays: 1 } }
      const email = makeStep('email')
      const end = makeStep('end')
      view.next = invite.id
      invite.next = cond.id
      cond.yes = msg.id
      cond.no = find.id
      find.next = hasEmail.id
      hasEmail.yes = email.id
      hasEmail.no = end.id
      return toSequence([view, invite, cond, msg, find, hasEmail, email, end], view.id)
    },
  },
]
