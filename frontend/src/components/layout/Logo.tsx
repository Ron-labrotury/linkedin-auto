import { Link } from 'react-router-dom'
import { cn } from '../../lib/utils'
import { LinkedInIcon } from '../ui/LinkedInIcon'

export function Logo({ compact, to = '/', className }: { compact?: boolean; to?: string | null; className?: string }) {
  const content = (
    <>
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand text-white">
        <LinkedInIcon size={20} />
      </span>
      {!compact && <span className="text-2xl font-bold tracking-tight">LinkPilot</span>}
    </>
  )
  const cls = cn('flex items-center gap-2.5', className)
  return to === null ? (
    <span className={cls}>{content}</span>
  ) : (
    <Link to={to} className={cls} aria-label="LinkPilot home">
      {content}
    </Link>
  )
}
