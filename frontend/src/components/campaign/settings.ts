/** Campaign settings defaults and client-side checks (same ranges as the API). Pure (tested). */
import type { CampaignSettings } from '@shared/types.ts'

export const DEFAULT_CAMPAIGN_SETTINGS: CampaignSettings = {
  dailyInvites: 25,
  dailyMessages: 40,
  dailyProfileViews: 50,
  skipConnected: true,
  skipOtherCampaigns: true,
  stopOnReply: true,
}

export type LimitKey = 'dailyInvites' | 'dailyMessages' | 'dailyProfileViews'

/** Allowed range (enforced by the API) and LinkedIn's practical safe value. */
export const LIMITS: Record<LimitKey, { max: number; safe: number; label: string }> = {
  dailyInvites: { max: 200, safe: 30, label: 'Connection invites per day' },
  dailyMessages: { max: 300, safe: 50, label: 'Messages per day' },
  dailyProfileViews: { max: 300, safe: 60, label: 'Profile views per day' },
}

export const NAME_MAX = 80

/** Field problems keyed like the API's `details` ("name", "settings.dailyInvites"). */
export function settingsErrors(name: string, s: CampaignSettings): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!name.trim()) errors.name = 'Enter a campaign name'
  else if (name.trim().length > NAME_MAX) errors.name = `Use at most ${NAME_MAX} characters`
  for (const k of Object.keys(LIMITS) as LimitKey[]) {
    const v = s[k]
    if (!Number.isInteger(v) || v < 0 || v > LIMITS[k].max) errors[`settings.${k}`] = `${LIMITS[k].label}: use a whole number from 0 to ${LIMITS[k].max}`
  }
  return errors
}
