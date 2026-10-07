import {
  Eye,
  Rss,
  Award,
  ThumbsUp,
  UserPlus,
  MessageSquare,
  UserMinus,
  AtSign,
  Mail,
  GitBranch,
  Flag,
  type LucideIcon,
} from 'lucide-react'
import type { StepKind } from '../../types'
import { STEP_META } from '../../lib/sequence'

export const STEP_ICON: Record<StepKind, LucideIcon> = {
  view_profile: Eye,
  follow: Rss,
  endorse: Award,
  like_post: ThumbsUp,
  invite: UserPlus,
  message: MessageSquare,
  withdraw: UserMinus,
  find_email: AtSign,
  email: Mail,
  condition: GitBranch,
  end: Flag,
}

/** Channel identity colors – always paired with an icon and a text label. */
export const CHANNEL_STYLE = {
  linkedin: { fg: 'text-info', bg: 'bg-info/15', ring: 'border-info/40', label: 'LinkedIn' },
  email: { fg: 'text-accent', bg: 'bg-accent/15', ring: 'border-accent/40', label: 'Email' },
  logic: { fg: 'text-brand', bg: 'bg-brand/15', ring: 'border-brand/40', label: 'Logic' },
} as const

export function StepIcon({ kind, size = 18 }: { kind: StepKind; size?: number }) {
  const Icon = STEP_ICON[kind]
  const ch = CHANNEL_STYLE[STEP_META[kind].channel]
  return (
    <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${ch.bg} ${ch.fg}`}>
      <Icon size={size} />
    </span>
  )
}
