// Run: node --test "frontend/src/**/*.test.ts"
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LinkedInAccount, LinkedInStatus } from '@shared/types.ts'

// Plain Node doesn't know Vite's "@shared/*" alias or extensionless imports.
registerHooks({
  resolve: (s, c, next) =>
    next(s.startsWith('@shared/') ? new URL(`../../../../shared/${s.slice(8)}`, import.meta.url).href : /^\.\.?\/(.*\/)?[^./]+$/.test(s) ? `${s}.ts` : s, c),
})
const { engineStatus, humanDuration } = await import('./engineStatus.ts')
const { timeUntil, formatWhen, jsonEqual, plural, pct, defaultCampaignName } = await import('../../lib/utils.ts')

const NOW = new Date(2026, 9, 7, 10, 0).getTime() // local time, Wed Oct 7 2026 10:00
const at = (ms: number) => new Date(NOW + ms).toISOString()
const linkedin = (status: LinkedInStatus): LinkedInAccount => ({ status, authMethod: null, email: null, profile: null, lastCheckedAt: null, lastError: null })
const dash = (status: LinkedInStatus, withinActiveHours: boolean, nextActionAt: string | null) => ({ linkedin: linkedin(status), withinActiveHours, nextActionAt })

test('idle without active campaigns', () => {
  assert.equal(engineStatus(dash('connected', true, null), 0, NOW).text, 'Idle – no active campaigns')
})

test('on hold while LinkedIn is not usable', () => {
  assert.match(engineStatus(dash('disconnected', true, null), 2, NOW).text, /connect your LinkedIn/)
  assert.match(engineStatus(dash('expired', true, null), 1, NOW).text, /expired/)
  assert.match(engineStatus(dash('needs_verification', true, null), 1, NOW).text, /finish connecting/)
  assert.equal(engineStatus(dash('error', true, null), 1, NOW).tone, 'bad')
})

test('outside active hours shows when it resumes', () => {
  const tomorrow9 = new Date(2026, 9, 8, 9, 0).toISOString()
  const s = engineStatus(dash('connected', false, tomorrow9), 1, NOW)
  assert.equal(s.tone, 'warn')
  assert.equal(s.text, 'Outside active hours – resumes tomorrow at 9:00 am')
  assert.equal(engineStatus(dash('connected', false, null), 1, NOW).text, 'Outside active hours')
})

test('next action countdown', () => {
  assert.equal(engineStatus(dash('connected', true, at(2 * 60_000)), 1, NOW).text, 'Next action in ~2 min')
  assert.equal(engineStatus(dash('connected', true, at(-5_000)), 1, NOW).text, 'Working – the next action is due now')
  assert.equal(engineStatus(dash('connected', true, null), 1, NOW).text, 'Waiting – no lead is due right now')
})

test('humanDuration', () => {
  assert.equal(humanDuration(10_000), '1 min')
  assert.equal(humanDuration(25 * 60_000), '25 min')
  assert.equal(humanDuration(3 * 3_600_000), '3 h')
  assert.equal(humanDuration(3 * 86_400_000), '3 days')
})

test('timeUntil for the leads table', () => {
  assert.equal(timeUntil(at(-60_000), NOW), 'due now')
  assert.equal(timeUntil(at(10_000), NOW), 'due now')
  assert.equal(timeUntil(at(3 * 60_000), NOW), 'in 3 min')
  assert.equal(timeUntil(at(2 * 3_600_000), NOW), 'in 2 h')
  assert.equal(timeUntil(at(4 * 86_400_000), NOW), 'in 4 d')
})

test('formatWhen uses today / tomorrow / a date', () => {
  assert.equal(formatWhen(new Date(2026, 9, 7, 17, 30).toISOString(), NOW), 'at 5:30 pm')
  assert.equal(formatWhen(new Date(2026, 9, 8, 9, 0).toISOString(), NOW), 'tomorrow at 9:00 am')
  assert.equal(formatWhen(new Date(2026, 9, 12, 9, 0).toISOString(), NOW), 'Mon, Oct 12 at 9:00 am')
})

test('jsonEqual ignores key order and undefined values', () => {
  assert.ok(jsonEqual({ a: 1, b: { c: [1, 2], d: undefined } }, { b: { c: [1, 2] }, a: 1 }))
  assert.ok(!jsonEqual({ a: [1, 2] }, { a: [2, 1] }))
  assert.ok(!jsonEqual({ next: null }, {}))
})

test('small formatters', () => {
  assert.equal(plural(1, 'lead'), '1 lead')
  assert.equal(plural(1200, 'lead'), '1,200 leads')
  assert.equal(plural(2, 'search', 'searches'), '2 searches')
  assert.equal(pct(1, 3), 33)
  assert.equal(pct(5, 0), 0)
  assert.equal(defaultCampaignName(new Date(2026, 0, 5, 9, 7)), 'Campaign 05.01.2026 09:07')
})
