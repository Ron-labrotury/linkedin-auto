// Run: node --test "frontend/src/**/*.test.ts"
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Sequence } from '@shared/types.ts'

// Plain Node doesn't know Vite's "@shared/*" alias or extensionless imports.
registerHooks({
  resolve: (s, c, next) =>
    next(s.startsWith('@shared/') ? new URL(`../../../../shared/${s.slice(8)}`, import.meta.url).href : /^\.\.?\/(.*\/)?[^./]+$/.test(s) ? `${s}.ts` : s, c),
})
const { campaignProblems } = await import('./problems.ts')
const { DEFAULT_CAMPAIGN_SETTINGS } = await import('../../components/campaign/settings.ts')
const { emptySequence, insertStep, makeStep } = await import('@shared/sequence.ts')

const inviteOnly = (): Sequence => insertStep(emptySequence(), null, 'next', makeStep('invite'))
const base = { name: 'Pune CTOs', settings: DEFAULT_CAMPAIGN_SETTINGS, sequence: inviteOnly(), leads: [{ profileUrl: 'https://www.linkedin.com/in/a/' }], searchImports: [] }

test('a complete campaign has no problems', () => {
  assert.deepEqual(campaignProblems(base), [])
  // a search alone is enough to launch
  assert.deepEqual(campaignProblems({ ...base, leads: [], searchImports: [{ url: 'https://www.linkedin.com/search/results/people/?keywords=x', max: 50 }] }), [])
})

test('missing leads and steps block the launch but not a draft', () => {
  const p = campaignProblems({ ...base, leads: [], sequence: emptySequence() })
  assert.deepEqual(
    p.map((x) => [x.tab, x.blocksDraft]),
    [
      ['leads', false],
      ['sequence', false],
    ],
  )
})

test('an empty message blocks even a draft and points to the sequence', () => {
  const s0 = inviteOnly()
  const withMsg = insertStep(s0, s0.rootId, 'next', makeStep('message'))
  const p = campaignProblems({ ...base, sequence: withMsg })
  assert.equal(p.length, 1)
  assert.equal(p[0].tab, 'sequence')
  assert.equal(p[0].blocksDraft, true)
  assert.match(p[0].message, /message is empty/)
})

test('name, limits and request size are checked', () => {
  const tooMany = Array.from({ length: 5001 }, (_, i) => ({ profileUrl: `https://www.linkedin.com/in/p${i}/` }))
  const p = campaignProblems({ ...base, name: ' ', settings: { ...DEFAULT_CAMPAIGN_SETTINGS, dailyInvites: 500 }, leads: tooMany })
  assert.deepEqual(
    p.map((x) => x.tab),
    ['settings', 'settings', 'leads'],
  )
  assert.ok(p.every((x) => x.blocksDraft))
})
