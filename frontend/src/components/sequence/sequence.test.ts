// Run: node --test "frontend/src/**/*.test.ts"
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Sequence, SequenceStep } from '@shared/types.ts'

// Plain Node doesn't know Vite's "@shared/*" alias or extensionless imports.
registerHooks({
  resolve: (s, c, next) =>
    next(s.startsWith('@shared/') ? new URL(`../../../../shared/${s.slice(8)}`, import.meta.url).href : /^\.\.?\/(.*\/)?[^./]+$/.test(s) ? `${s}.ts` : s, c),
})
const { delayError, withinError, stepNumbers, stepTitle, unknownVariables } = await import('../../lib/sequence.ts')
const { layoutSequence } = await import('./layout.ts')
const { makeStep, insertStep, emptySequence, validateSequence, DEFAULT_DELAY } = await import('@shared/sequence.ts')

const step = (id: string, kind: SequenceStep['kind'], extra: Partial<SequenceStep> = {}): SequenceStep => ({ ...makeStep(kind), id, ...extra })

/** invite → if accepted ? (message → if replied ? end : follow-up) : withdraw */
function typicalFlow(): Sequence {
  const steps = [
    step('inv', 'invite', { next: 'c1' }),
    step('c1', 'condition', { yes: 'm1', no: 'wd' }),
    step('m1', 'message', { config: { message: 'Hi {{first_name}}' }, next: 'c2' }),
    step('c2', 'condition', { config: { condition: 'replied', within: { value: 3, unit: 'days' } }, yes: 'end', no: 'm2' }),
    step('end', 'end'),
    step('m2', 'message', { config: { message: 'Following up' } }),
    step('wd', 'withdraw'),
  ]
  return { rootId: 'inv', steps: Object.fromEntries(steps.map((s) => [s.id, s])) }
}

test('new steps wait a random 1–5 minutes by default', () => {
  assert.deepEqual(DEFAULT_DELAY, { min: 1, max: 5, unit: 'minutes' })
  assert.deepEqual(makeStep('invite').delay, { min: 1, max: 5, unit: 'minutes' })
  assert.equal(delayError(makeStep('message').delay), null)
})

test('delayError checks min ≤ max and the 90-day ceiling', () => {
  assert.equal(delayError({ min: 0, max: 0, unit: 'minutes' }), null)
  assert.match(delayError({ min: 6, max: 5, unit: 'minutes' }) ?? '', /minimum/)
  assert.equal(delayError({ min: 1, max: 90, unit: 'days' }), null)
  assert.match(delayError({ min: 1, max: 91, unit: 'days' }) ?? '', /90 days/)
  assert.match(delayError({ min: 1, max: 2161, unit: 'hours' }) ?? '', /90 days/)
  assert.ok(delayError({ min: -1, max: 2, unit: 'hours' }))
})

test('withinError requires a positive wait of at most 90 days', () => {
  assert.equal(withinError({ value: 7, unit: 'days' }), null)
  assert.ok(withinError({ value: 0, unit: 'days' }))
  assert.ok(withinError(undefined))
  assert.ok(withinError({ value: 91, unit: 'days' }))
})

test('stepNumbers follows reading order: Yes branch before No', () => {
  const nums = stepNumbers(typicalFlow())
  assert.deepEqual([...nums.entries()], [
    ['inv', 1],
    ['c1', 2],
    ['m1', 3],
    ['c2', 4],
    ['end', 5],
    ['m2', 6],
    ['wd', 7],
  ])
})

test('the canvas numbers steps like stepNumbers and offers + on open branches only when editable', () => {
  const seq = typicalFlow()
  const { nodes, edges } = layoutSequence(seq, { readOnly: false, startTitle: 'Campaign start', startSubtitle: '3 leads' })
  const nums = stepNumbers(seq)
  for (const n of nodes) if (n.type === 'step') assert.equal(n.data.index, nums.get(n.id))
  // open ends: after m2 and after wd (end has no children)
  assert.deepEqual(
    nodes.filter((n) => n.type === 'add').map((n) => n.id).sort(),
    ['add_m2_next', 'add_wd_next'],
  )
  const edge = edges.find((e) => e.target === 'm1')
  assert.equal(edge?.data?.branch, 'yes')
  assert.deepEqual(edge?.data?.delay, seq.steps.m1.delay)

  const ro = layoutSequence(seq, { readOnly: true, startTitle: 'Campaign start', startSubtitle: '' })
  assert.equal(ro.nodes.filter((n) => n.type === 'add').length, 0)
})

test('an empty sequence shows the start card and one + to add the first step', () => {
  const { nodes } = layoutSequence(emptySequence(), { readOnly: false, startTitle: 'Campaign start', startSubtitle: 'No leads yet' })
  assert.deepEqual(nodes.map((n) => n.type), ['start', 'add', 'hint'])
  const hint = nodes[2]
  assert.ok(hint.position.y > nodes[1].position.y, 'the hint sits below the first +')
  const add = nodes[1]
  assert.ok(add.type === 'add' && add.data.first && add.data.parentId === null)
  assert.deepEqual(validateSequence(emptySequence()), [])
  const ro = layoutSequence(emptySequence(), { readOnly: true, startTitle: 'Campaign start', startSubtitle: '' })
  assert.deepEqual(ro.nodes.map((n) => n.type), ['start'])
})

test('building the typical flow step by step yields a valid sequence', () => {
  let seq = emptySequence()
  const invite = makeStep('invite')
  seq = insertStep(seq, null, 'next', invite)
  const cond = { ...makeStep('condition') }
  seq = insertStep(seq, invite.id, 'next', cond)
  const msg = { ...makeStep('message'), config: { message: 'Thanks for connecting, {{first_name}}!' } }
  seq = insertStep(seq, cond.id, 'yes', msg)
  assert.deepEqual(validateSequence(seq), [])
  assert.equal(stepTitle(seq.steps[cond.id]), 'If invite accepted')
  assert.equal(stepTitle(seq.steps[msg.id]), 'Send message')
})

test('unknownVariables flags typos but not the supported variables', () => {
  const known = ['first_name', 'company']
  assert.deepEqual(unknownVariables('Hi {{first_name}} at {{ company }}', known), [])
  assert.deepEqual(unknownVariables('Hi {{firstname}} {{first name}} {{firstname}}', known), ['firstname', 'first name'])
})
