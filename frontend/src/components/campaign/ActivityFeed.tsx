import { Link } from 'react-router-dom'
import { Eye, Rss, ThumbsUp, UserPlus, MessageSquare, UserMinus, UserCheck, Reply, GitBranch, Download, KeyRound, type LucideIcon } from 'lucide-react'
import type { Activity, ActivityType } from '@shared/types.ts'
import { cn, formatDateTime, timeAgo } from '../../lib/utils'
import { SESSION_PROBLEM_TEXT, sessionProblem } from './sessionActivity'

const META: Record<ActivityType, { icon: LucideIcon; success: string; failed: string; skipped: string }> = {
  view_profile: { icon: Eye, success: 'Viewed the profile of', failed: 'Couldn’t view the profile of', skipped: 'Skipped viewing the profile of' },
  follow: { icon: Rss, success: 'Followed', failed: 'Couldn’t follow', skipped: 'Skipped following' },
  like_post: { icon: ThumbsUp, success: 'Liked a post by', failed: 'Couldn’t like a post by', skipped: 'Didn’t like a post by' },
  invite: { icon: UserPlus, success: 'Sent an invite to', failed: 'Couldn’t send an invite to', skipped: 'Skipped the invite to' },
  message: { icon: MessageSquare, success: 'Sent a message to', failed: 'Couldn’t send a message to', skipped: 'Skipped the message to' },
  withdraw: { icon: UserMinus, success: 'Withdrew the invite to', failed: 'Couldn’t withdraw the invite to', skipped: 'Nothing to withdraw for' },
  accepted: { icon: UserCheck, success: 'Invite accepted by', failed: 'Couldn’t check the invite to', skipped: 'Skipped the invite check for' },
  replied: { icon: Reply, success: 'New reply from', failed: 'Couldn’t check replies from', skipped: 'Skipped the reply check for' },
  condition: { icon: GitBranch, success: 'Checked a condition for', failed: 'Couldn’t check a condition for', skipped: 'Skipped a condition for' },
  import: { icon: Download, success: 'Collected leads from a LinkedIn search', failed: 'Couldn’t collect leads from a LinkedIn search', skipped: 'Skipped a LinkedIn search' },
  session: { icon: KeyRound, success: 'LinkedIn session', failed: 'LinkedIn session problem', skipped: 'LinkedIn session' },
}

export function ActivityItem({ a, showCampaign = true }: { a: Activity; showCampaign?: boolean }) {
  const meta = META[a.type] ?? META.session
  const Icon = meta.icon
  const failed = a.status === 'failed'
  // account-wide LinkedIn trouble (network down, session expired, account problem): say what it means
  const session = a.type === 'session' && failed ? SESSION_PROBLEM_TEXT[sessionProblem(a.detail)] : null
  const warn = session?.tone === 'warn'
  return (
    <li className="flex gap-4 border-b border-line py-4 last:border-0">
      <span
        className={cn(
          'mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg border',
          warn
            ? 'border-warn/40 bg-warn/10 text-warn'
            : failed
              ? 'border-bad/40 bg-bad/10 text-bad'
              : a.status === 'skipped'
                ? 'border-line text-ink-3'
                : 'border-line-strong text-ink-2',
        )}
        aria-hidden
      >
        <Icon size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn('text-[15px] leading-snug', warn ? 'text-warn' : failed && 'text-bad')}>
          {session ? session.title : (meta[a.status] ?? meta.success)}
          {a.leadName && <span className={cn('font-medium', failed ? 'text-bad' : 'text-brand')}> {a.leadName}</span>}
        </p>
        {a.detail && (
          <p className={cn('mt-1 break-words text-sm', warn ? 'text-ink-2' : failed ? 'text-bad/90' : a.status === 'skipped' ? 'text-warn' : 'text-ink-3')}>{a.detail}</p>
        )}
        {session && (
          <p className="mt-1 text-sm text-ink-3">
            {session.hint}
            {session.settingsLink && (
              <>
                {' '}
                <Link to="/settings#linkedin" className="text-brand hover:underline">Open LinkedIn settings</Link>
              </>
            )}
          </p>
        )}
        <p className="mt-1.5 text-sm text-ink-2">
          <time dateTime={a.createdAt} title={formatDateTime(a.createdAt)}>{timeAgo(a.createdAt)}</time>
          {showCampaign && a.campaignName && (
            <>
              {' · '}
              {a.campaignId ? (
                <Link to={`/campaigns/${a.campaignId}`} className="text-brand hover:underline">{a.campaignName}</Link>
              ) : (
                <span>{a.campaignName}</span>
              )}
            </>
          )}
        </p>
      </div>
    </li>
  )
}

export function ActivityList({ items, showCampaign }: { items: Activity[]; showCampaign?: boolean }) {
  return (
    <ul>
      {items.map((a) => (
        <ActivityItem key={a.id} a={a} showCampaign={showCampaign} />
      ))}
    </ul>
  )
}
