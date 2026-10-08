import type { UserSettings } from '../../../shared/types.ts'
import { DEFAULT_SETTINGS } from '../../../shared/time.ts'
import { type DB, one, run } from '../db/index.ts'
import { parseJson } from './util.ts'

export interface SettingsRow {
  user_id: string
  timezone: string
  active_days_json: string
  active_start: string
  active_end: string
  gap_min_minutes: number
  gap_max_minutes: number
  updated_at: number
}

export const toSettings = (r: SettingsRow): UserSettings => ({
  timezone: r.timezone,
  activeDays: parseJson<number[]>(r.active_days_json, [...DEFAULT_SETTINGS.activeDays]),
  activeStart: r.active_start,
  activeEnd: r.active_end,
  gapMinMinutes: r.gap_min_minutes,
  gapMaxMinutes: r.gap_max_minutes,
})

export function getSettings(db: DB, userId: string): UserSettings {
  const row = one<SettingsRow>(db, 'SELECT * FROM user_settings WHERE user_id = ?', userId)
  return row ? toSettings(row) : { ...DEFAULT_SETTINGS, activeDays: [...DEFAULT_SETTINGS.activeDays] }
}

export function saveSettings(db: DB, userId: string, s: UserSettings, now = Date.now()) {
  run(
    db,
    `INSERT INTO user_settings (user_id, timezone, active_days_json, active_start, active_end, gap_min_minutes, gap_max_minutes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       timezone = excluded.timezone, active_days_json = excluded.active_days_json,
       active_start = excluded.active_start, active_end = excluded.active_end,
       gap_min_minutes = excluded.gap_min_minutes, gap_max_minutes = excluded.gap_max_minutes,
       updated_at = excluded.updated_at`,
    userId,
    s.timezone,
    JSON.stringify(s.activeDays),
    s.activeStart,
    s.activeEnd,
    s.gapMinMinutes,
    s.gapMaxMinutes,
    now,
  )
}
