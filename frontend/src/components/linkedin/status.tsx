import type { LinkedInStatus } from '@shared/types.ts'
import { cn } from '../../lib/utils'
import { Badge, type BadgeTone } from '../ui'
import { LinkedInIcon } from '../ui/LinkedInIcon'

export const LINKEDIN_STATUS: Record<LinkedInStatus, { label: string; tone: BadgeTone; dot: string }> = {
  connected: { label: 'Connected', tone: 'ok', dot: 'bg-ok' },
  needs_verification: { label: 'Needs verification', tone: 'warn', dot: 'bg-warn' },
  needs_app_approval: { label: 'Waiting for app approval', tone: 'warn', dot: 'bg-warn' },
  expired: { label: 'Session expired', tone: 'bad', dot: 'bg-bad' },
  error: { label: 'Needs attention', tone: 'bad', dot: 'bg-bad' },
  disconnected: { label: 'Not connected', tone: 'neutral', dot: 'bg-bad' },
}

export const isPendingLogin = (s: LinkedInStatus) => s === 'needs_verification' || s === 'needs_app_approval'

export function LinkedInStatusBadge({ status }: { status: LinkedInStatus }) {
  const s = LINKEDIN_STATUS[status]
  return (
    <Badge tone={s.tone}>
      <LinkedInIcon size={12} /> {s.label}
    </Badge>
  )
}

/** Small coloured dot: green connected, amber waiting for verification, red otherwise. */
export function StatusDot({ status, className }: { status: LinkedInStatus | undefined; className?: string }) {
  return (
    <span
      className={cn('inline-block size-2.5 shrink-0 rounded-full', status ? LINKEDIN_STATUS[status].dot : 'bg-line-strong', className)}
      aria-hidden
    />
  )
}
