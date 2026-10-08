import { Router } from 'express'
import type { UserSettings } from '../../../shared/types.ts'
import { validateUserSettings } from '../../../shared/time.ts'
import { HttpError } from '../http/errors.ts'
import { body } from '../http/request.ts'
import type { AppDeps } from '../http/types.ts'
import { auth } from '../auth/middleware.ts'
import { getSettings, saveSettings } from '../repo/settings.ts'

export function settingsRouter({ db }: AppDeps) {
  const r = Router()

  r.get('/', (req, res) => {
    res.json(getSettings(db, auth(req).user.id))
  })

  r.put('/', (req, res) => {
    const raw = body(req) as Record<string, unknown>
    // Wrong types become invalid values so validateUserSettings reports them per field.
    const input = {
      timezone: typeof raw.timezone === 'string' ? raw.timezone.trim() : '',
      activeDays: raw.activeDays,
      activeStart: typeof raw.activeStart === 'string' ? raw.activeStart.trim() : '',
      activeEnd: typeof raw.activeEnd === 'string' ? raw.activeEnd.trim() : '',
      gapMinMinutes: raw.gapMinMinutes,
      gapMaxMinutes: raw.gapMaxMinutes,
    } as UserSettings
    const errors = validateUserSettings(input)
    if (Object.keys(errors).length) throw new HttpError(400, Object.values(errors)[0], errors)
    const settings: UserSettings = { ...input, activeDays: [...new Set(input.activeDays)].sort((a, b) => a - b) }
    saveSettings(db, auth(req).user.id, settings)
    res.json(settings)
  })

  return r
}
