// Run: node --test "frontend/src/**/*.test.ts"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CampaignStatus, CampaignSummary, LinkedInAccount } from '@shared/types.ts'
import { setupSteps } from './setup.ts'

const account = (status: LinkedInAccount['status']): LinkedInAccount => ({
  status,
  authMethod: null,
  email: null,
  profile: null,
  lastCheckedAt: null,
  lastError: null,
})

const campaign = (status: CampaignStatus) => ({ id: status, status }) as CampaignSummary

const done = (steps: ReturnType<typeof setupSteps>) => steps.filter((s) => s.done).map((s) => s.id)

test('new user has nothing done', () => {
  const steps = setupSteps(account('disconnected'), [])
  assert.deepEqual(done(steps), [])
  assert.equal(steps.find((s) => s.id === 'launch')?.to, '/campaigns/new')
})

test('connected with a draft campaign', () => {
  assert.deepEqual(done(setupSteps(account('connected'), [campaign('draft')])), ['linkedin', 'create'])
})

test('a paused or completed campaign counts as launched; expired LinkedIn does not count', () => {
  assert.deepEqual(done(setupSteps(account('expired'), [campaign('draft'), campaign('paused')])), ['create', 'launch'])
  assert.deepEqual(done(setupSteps(account('connected'), [campaign('completed')])), ['linkedin', 'create', 'launch'])
})
