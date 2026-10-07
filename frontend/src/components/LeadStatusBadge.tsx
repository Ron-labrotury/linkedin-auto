import type { LeadStatus } from '../types'
import { Badge } from './ui'

const MAP: Record<LeadStatus, { label: string; tone: 'neutral' | 'brand' | 'ok' | 'warn' | 'bad' | 'info' }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  in_progress: { label: 'In progress', tone: 'info' },
  invited: { label: 'Invited', tone: 'brand' },
  connected: { label: 'Connected', tone: 'ok' },
  replied: { label: 'Replied', tone: 'ok' },
  finished: { label: 'Finished', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'bad' },
}

export const LEAD_STATUS_LABEL = Object.fromEntries(Object.entries(MAP).map(([k, v]) => [k, v.label])) as Record<LeadStatus, string>

export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  const m = MAP[status]
  return <Badge tone={m.tone}>{m.label}</Badge>
}
