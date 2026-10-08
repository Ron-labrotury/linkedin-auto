/** The dashboard's one-line "what is the engine doing" summary. Pure (tested). */
import type { Dashboard } from '@shared/types.ts'
import { formatWhen } from '../../lib/utils'

export interface EngineStatus {
  tone: 'ok' | 'warn' | 'bad' | 'idle'
  text: string
}

/** "1 min", "25 min", "3 h", "2 days" */
export function humanDuration(ms: number) {
  const min = Math.max(1, Math.round(ms / 60_000))
  if (min < 60) return `${min} min`
  const h = Math.round(min / 60)
  if (h < 48) return `${h} h`
  return `${Math.round(h / 24)} days`
}

export function engineStatus(d: Pick<Dashboard, 'linkedin' | 'withinActiveHours' | 'nextActionAt'>, activeCampaigns: number, now = Date.now()): EngineStatus {
  if (activeCampaigns === 0) return { tone: 'idle', text: 'Idle – no active campaigns' }
  switch (d.linkedin.status) {
    case 'connected':
      break
    case 'expired':
      return { tone: 'bad', text: 'On hold – your LinkedIn session expired. Reconnect to continue.' }
    case 'needs_verification':
    case 'needs_app_approval':
      return { tone: 'warn', text: 'On hold – finish connecting your LinkedIn account' }
    case 'error':
      return { tone: 'bad', text: 'On hold – your LinkedIn connection has a problem. Reconnect to continue.' }
    default:
      return { tone: 'bad', text: 'On hold – connect your LinkedIn account to start sending' }
  }
  if (!d.withinActiveHours) return { tone: 'warn', text: d.nextActionAt ? `Outside active hours – resumes ${formatWhen(d.nextActionAt, now)}` : 'Outside active hours' }
  if (!d.nextActionAt) return { tone: 'idle', text: 'Waiting – no lead is due right now' }
  const ms = new Date(d.nextActionAt).getTime() - now
  if (ms <= 30_000) return { tone: 'ok', text: 'Working – the next action is due now' }
  return { tone: 'ok', text: `Next action in ~${humanDuration(ms)}` }
}
