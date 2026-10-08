// Run: node --test "frontend/src/**/*.test.ts"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { UserSettings } from '@shared/types.ts'
import { describeDays, formatIn, formatWeekdayTime, sameSettings, scheduleStatus, timeZoneOptions, windowLength } from './schedule.ts'

const base: UserSettings = {
  timezone: 'Asia/Kolkata',
  activeDays: [1, 2, 3, 4, 5],
  activeStart: '09:00',
  activeEnd: '18:00',
  gapMinMinutes: 1,
  gapMaxMinutes: 5,
}

test('active inside the window', () => {
  // Wed 2026-10-07 12:00 IST = 06:30 UTC
  const s = scheduleStatus(new Date('2026-10-07T06:30:00Z'), base)
  assert.deepEqual(s, { state: 'active', until: '18:00' })
})

test('after hours: next window is tomorrow morning in the user zone', () => {
  // Wed 19:00 IST
  const s = scheduleStatus(new Date('2026-10-07T13:30:00Z'), base)
  assert.equal(s.state, 'waiting')
  if (s.state !== 'waiting') return
  assert.equal(s.label, 'Thu 09:00')
  assert.equal(s.nextAt.toISOString(), '2026-10-08T03:30:00.000Z')
  assert.equal(s.relative, 'in 14 h')
})

test('weekend skips to Monday', () => {
  // Sat 2026-10-10 10:00 IST
  const s = scheduleStatus(new Date('2026-10-10T04:30:00Z'), base)
  assert.equal(s.state, 'waiting')
  if (s.state === 'waiting') assert.equal(s.label, 'Mon 09:00')
})

test('invalid settings are reported, not computed', () => {
  assert.equal(scheduleStatus(new Date(), { ...base, activeEnd: '08:00' }).state, 'invalid')
  assert.equal(scheduleStatus(new Date(), { ...base, activeDays: [] }).state, 'invalid')
  assert.equal(scheduleStatus(new Date(), { ...base, gapMaxMinutes: Number.NaN }).state, 'invalid')
})

test('formatting helpers', () => {
  assert.equal(formatIn(30_000), 'in 1 min')
  assert.equal(formatIn(45 * 60_000), 'in 45 min')
  assert.equal(formatIn(200 * 60_000), 'in 3 h 20 min')
  assert.equal(formatIn(5 * 86_400_000), 'in 5 days')
  assert.equal(formatWeekdayTime(new Date('2026-10-07T23:15:00Z'), 'America/New_York'), 'Wed 19:15')
  assert.equal(windowLength('09:00', '18:00'), '9 h')
  assert.equal(windowLength('09:15', '17:00'), '7 h 45 min')
  assert.equal(windowLength('18:00', '09:00'), null)
})

test('describeDays', () => {
  assert.equal(describeDays([1, 2, 3, 4, 5]), 'Mon–Fri')
  assert.equal(describeDays([0, 1, 2, 3, 4, 5, 6]), 'Every day')
  assert.equal(describeDays([0, 6]), 'Weekends')
  assert.equal(describeDays([1, 3, 5]), 'Mon, Wed, Fri')
  assert.equal(describeDays([5, 6, 0]), 'Fri–Sun')
  assert.equal(describeDays([]), 'No days')
})

test('timeZoneOptions always contains UTC and the saved zone', () => {
  const opts = timeZoneOptions(new Date('2026-01-15T00:00:00Z'), ['Asia/Calcutta', null])
  const values = opts.map((o) => o.value)
  assert.ok(values.includes('UTC'))
  assert.ok(values.includes('Asia/Calcutta'))
  assert.deepEqual(values, [...values].sort((a, b) => a.localeCompare(b)))
  const kolkata = opts.find((o) => o.value === 'Asia/Kolkata')
  assert.match(kolkata?.label ?? '', /Asia\/Kolkata \(GMT\+5:30\)/)
})

test('sameSettings ignores day order', () => {
  assert.equal(sameSettings(base, { ...base, activeDays: [5, 4, 3, 2, 1] }), true)
  assert.equal(sameSettings(base, { ...base, gapMaxMinutes: 6 }), false)
})
