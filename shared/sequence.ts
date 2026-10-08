/**
 * Sequence model helpers shared by the builder (frontend) and the engine (backend).
 * A sequence is a tree stored flat: `{ rootId, steps }`. Linear steps point to `next`;
 * conditions point to `yes` / `no`; `end` has no children.
 */
import type { BranchKey, Delay, Duration, Sequence, SequenceStep, StepKind } from './types.ts'

export const INVITE_NOTE_LIMIT = 300
export const MESSAGE_LIMIT = 8000
export const MAX_DELAY_DAYS = 90
export const MAX_STEPS = 50

export const DEFAULT_DELAY: Delay = { min: 1, max: 5, unit: 'minutes' }
export const NO_DELAY: Delay = { min: 0, max: 0, unit: 'minutes' }
export const DEFAULT_CONDITION_WITHIN: Duration = { value: 7, unit: 'days' }

export const STEP_KINDS: StepKind[] = ['view_profile', 'follow', 'like_post', 'invite', 'message', 'withdraw', 'condition', 'end']
export const CONDITION_KINDS = ['accepted_invite', 'is_connected', 'replied'] as const

export const TEMPLATE_VARIABLES = ['first_name', 'last_name', 'company', 'title', 'location'] as const

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const

export const durationToMs = (d: Duration) => d.value * UNIT_MS[d.unit]

/** Pick a random delay in [min, max] (whole seconds) for a step. */
export function pickDelayMs(delay: Delay, rand: () => number = Math.random) {
  const lo = delay.min * UNIT_MS[delay.unit]
  const hi = delay.max * UNIT_MS[delay.unit]
  return Math.round((lo + rand() * Math.max(0, hi - lo)) / 1000) * 1000
}

export function formatDelay(d: Delay) {
  if (d.max <= 0) return 'Immediately'
  const unit = d.unit === 'minutes' ? 'min' : d.unit === 'hours' ? 'h' : 'd'
  return d.min === d.max ? `Wait ${d.min} ${unit}` : `Wait ${d.min}–${d.max} ${unit}`
}

export function formatDuration(d: Duration) {
  const unit = d.value === 1 ? d.unit.slice(0, -1) : d.unit
  return `${d.value} ${unit}`
}

const newId = () => `step_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`

export function makeStep(kind: StepKind): SequenceStep {
  const base: SequenceStep = { id: newId(), kind, delay: { ...DEFAULT_DELAY }, config: {} }
  switch (kind) {
    case 'invite':
      return { ...base, config: { message: '' } }
    case 'message':
      return { ...base, config: { message: '' } }
    case 'condition':
      return { ...base, delay: { ...NO_DELAY }, config: { condition: 'accepted_invite', within: { ...DEFAULT_CONDITION_WITHIN } } }
    case 'end':
      return { ...base, delay: { ...NO_DELAY } }
    default:
      return base
  }
}

export const emptySequence = (): Sequence => ({ rootId: null, steps: {} })

export function branchesOf(step: SequenceStep): BranchKey[] {
  if (step.kind === 'end') return []
  return step.kind === 'condition' ? ['yes', 'no'] : ['next']
}

function removeSubtree(steps: Record<string, SequenceStep>, id: string | null | undefined) {
  if (!id || !steps[id]) return
  const s = steps[id]
  delete steps[id]
  removeSubtree(steps, s.next)
  removeSubtree(steps, s.yes)
  removeSubtree(steps, s.no)
}

/** Insert `step` at `parentId[branch]` (or as the root when parentId is null). The existing child is reattached below it. */
export function insertStep(seq: Sequence, parentId: string | null, branch: BranchKey, step: SequenceStep): Sequence {
  const steps = { ...seq.steps }
  const existing = parentId ? (steps[parentId]?.[branch] ?? null) : seq.rootId
  const s: SequenceStep = { ...step }
  if (existing) {
    if (s.kind === 'condition') s.yes = existing
    else if (s.kind !== 'end') s.next = existing
    else removeSubtree(steps, existing) // an "end" mid-sequence drops what follows
  }
  steps[s.id] = s
  if (parentId) {
    steps[parentId] = { ...steps[parentId], [branch]: s.id }
    return { ...seq, steps }
  }
  return { rootId: s.id, steps }
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

/** The id of the step that follows `step`. For conditions pass the outcome. */
export function nextStepId(step: SequenceStep, outcome?: boolean): string | null {
  if (step.kind === 'end') return null
  if (step.kind === 'condition') return (outcome ? step.yes : step.no) ?? null
  return step.next ?? null
}

/** Fill {{variables}} with lead data. Unknown or empty variables become "". */
export function renderTemplate(text: string, vars: Partial<Record<(typeof TEMPLATE_VARIABLES)[number], string>>) {
  return text
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => (vars as Record<string, string | undefined>)[k]?.trim() ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export interface ValidationIssue {
  stepId: string | null
  message: string
}

const STEP_LABEL: Record<StepKind, string> = {
  view_profile: 'View profile',
  follow: 'Follow',
  like_post: 'Like latest post',
  invite: 'Send invite',
  message: 'Send message',
  withdraw: 'Withdraw invite',
  condition: 'Condition',
  end: 'End',
}

function validDelay(d: unknown): d is Delay {
  if (!d || typeof d !== 'object') return false
  const x = d as Delay
  if (!['minutes', 'hours', 'days'].includes(x.unit)) return false
  if (!Number.isFinite(x.min) || !Number.isFinite(x.max) || x.min < 0 || x.max < x.min) return false
  return x.max * UNIT_MS[x.unit] <= MAX_DELAY_DAYS * UNIT_MS.days
}

/**
 * Full validation: structure (references, cycles, reachability) plus content.
 * The server rejects sequences with issues; the builder shows them inline.
 */
export function validateSequence(seq: Sequence): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!seq || typeof seq !== 'object' || typeof seq.steps !== 'object' || seq.steps === null) {
    return [{ stepId: null, message: 'Sequence is malformed' }]
  }
  const ids = Object.keys(seq.steps)
  if (ids.length > MAX_STEPS) issues.push({ stepId: null, message: `A sequence can have at most ${MAX_STEPS} steps` })
  if (seq.rootId === null) {
    if (ids.length) issues.push({ stepId: null, message: 'Sequence has steps but no start' })
    return issues
  }
  if (!seq.steps[seq.rootId]) return [{ stepId: null, message: 'Sequence start points to a missing step' }]

  // Walk the tree: every step must be reached exactly once (no cycles, no shared children).
  const seen = new Set<string>()
  const stack = [seq.rootId]
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) {
      issues.push({ stepId: id, message: 'Sequence contains a loop or a step with two parents' })
      continue
    }
    seen.add(id)
    const s = seq.steps[id]
    if (s.id !== id) issues.push({ stepId: id, message: 'Step id mismatch' })
    if (!STEP_KINDS.includes(s.kind)) {
      issues.push({ stepId: id, message: `Unknown step type "${String(s.kind)}"` })
      continue
    }
    const allowed = branchesOf(s)
    for (const b of ['next', 'yes', 'no'] as BranchKey[]) {
      const child = s[b]
      if (child == null) continue
      if (!allowed.includes(b)) issues.push({ stepId: id, message: `${STEP_LABEL[s.kind]}: unexpected "${b}" branch` })
      else if (!seq.steps[child]) issues.push({ stepId: id, message: `${STEP_LABEL[s.kind]}: points to a missing step` })
      else stack.push(child)
    }
    if (!validDelay(s.delay)) issues.push({ stepId: id, message: `${STEP_LABEL[s.kind]}: delay must be 0–${MAX_DELAY_DAYS} days with min ≤ max` })

    const msg = s.config?.message ?? ''
    if (s.kind === 'message') {
      if (!msg.trim()) issues.push({ stepId: id, message: 'Send message: message is empty' })
      if (msg.length > MESSAGE_LIMIT) issues.push({ stepId: id, message: `Send message: longer than ${MESSAGE_LIMIT} characters` })
    }
    if (s.kind === 'invite' && msg.length > INVITE_NOTE_LIMIT)
      issues.push({ stepId: id, message: `Send invite: note exceeds ${INVITE_NOTE_LIMIT} characters` })
    if (s.kind === 'condition') {
      if (!CONDITION_KINDS.includes(s.config?.condition as (typeof CONDITION_KINDS)[number]))
        issues.push({ stepId: id, message: 'Condition: choose what to check' })
      const w = s.config?.within
      if (!w || !['minutes', 'hours', 'days'].includes(w.unit) || !(w.value > 0) || durationToMs(w) > MAX_DELAY_DAYS * UNIT_MS.days)
        issues.push({ stepId: id, message: `Condition: wait time must be between 1 minute and ${MAX_DELAY_DAYS} days` })
    }
  }
  for (const id of ids) if (!seen.has(id)) issues.push({ stepId: id, message: 'Step is not connected to the sequence' })
  return issues
}
