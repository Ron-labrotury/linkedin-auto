import type { LeadStatus } from '@shared/types.ts'
import { Badge, type BadgeTone } from './ui'

export const LEAD_STATUS: Record<LeadStatus, { label: string; tone: BadgeTone; description: string }> = {
  queued: { label: 'Queued', tone: 'neutral', description: 'Waiting for the first step' },
  in_progress: { label: 'In progress', tone: 'info', description: 'The sequence is running; no invite sent yet' },
  invited: { label: 'Invited', tone: 'brand', description: 'Invite sent, not accepted yet' },
  connected: { label: 'Connected', tone: 'ok', description: '1st-degree connection' },
  replied: { label: 'Replied', tone: 'ok', description: 'Replied on LinkedIn' },
  finished: { label: 'Finished', tone: 'neutral', description: 'Reached the end of the sequence' },
  skipped: { label: 'Skipped', tone: 'warn', description: 'Excluded (e.g. already in another active campaign)' },
  failed: { label: 'Failed', tone: 'bad', description: 'An action failed repeatedly' },
}

export const LEAD_STATUSES = Object.keys(LEAD_STATUS) as LeadStatus[]

export const LEAD_STATUS_LABEL = Object.fromEntries(LEAD_STATUSES.map((k) => [k, LEAD_STATUS[k].label])) as Record<LeadStatus, string>

export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  const m = LEAD_STATUS[status] ?? { label: status, tone: 'neutral' as const, description: '' }
  return (
    <span title={m.description}>
      <Badge tone={m.tone}>{m.label}</Badge>
    </span>
  )
}
