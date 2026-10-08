import { Eye, Rss, ThumbsUp, UserPlus, MessageSquare, UserMinus, GitBranch, Flag, UserCheck, Reply, Link2, type LucideIcon } from 'lucide-react'
import type { ConditionKind, StepKind } from '@shared/types.ts'
import { STEP_META } from '../../lib/sequence'
import { cn } from '../../lib/utils'

export const STEP_ICON: Record<StepKind, LucideIcon> = {
  view_profile: Eye,
  follow: Rss,
  like_post: ThumbsUp,
  invite: UserPlus,
  message: MessageSquare,
  withdraw: UserMinus,
  condition: GitBranch,
  end: Flag,
}

export const CONDITION_ICON: Record<ConditionKind, LucideIcon> = {
  accepted_invite: UserCheck,
  replied: Reply,
  is_connected: Link2,
}

/** Channel identity colors – always paired with an icon and a text label. */
export const CHANNEL_STYLE = {
  linkedin: { fg: 'text-info', bg: 'bg-info/15', ring: 'border-info/40', label: 'LinkedIn' },
  logic: { fg: 'text-brand', bg: 'bg-brand/15', ring: 'border-brand/40', label: 'Logic' },
} as const

export function StepIcon({ kind, condition, size = 18, className }: { kind: StepKind; condition?: ConditionKind; size?: number; className?: string }) {
  const Icon = (kind === 'condition' && condition && CONDITION_ICON[condition]) || STEP_ICON[kind] || GitBranch
  const ch = CHANNEL_STYLE[STEP_META[kind]?.channel ?? 'logic']
  return (
    <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', ch.bg, ch.fg, className)} aria-hidden>
      <Icon size={size} />
    </span>
  )
}
