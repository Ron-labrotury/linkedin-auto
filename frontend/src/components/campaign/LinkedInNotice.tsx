import { Link } from 'react-router-dom'
import type { LinkedInStatus } from '@shared/types.ts'
import { useLinkedInAccount } from '../../api/hooks-campaigns'
import { Alert } from '../ui'
import { LinkedInIcon } from '../ui/LinkedInIcon'

const TEXT: Record<Exclude<LinkedInStatus, 'connected'>, { title: string; body: string; action: string }> = {
  disconnected: {
    title: 'LinkedIn isn’t connected yet',
    body: 'The campaign will start sending once your LinkedIn account is connected.',
    action: 'Connect LinkedIn',
  },
  needs_verification: {
    title: 'LinkedIn is waiting for a verification code',
    body: 'Finish connecting your account – nothing is sent until then.',
    action: 'Finish connecting',
  },
  needs_app_approval: {
    title: 'Approve the sign-in in the LinkedIn app',
    body: 'Finish connecting your account – nothing is sent until then.',
    action: 'Finish connecting',
  },
  expired: {
    title: 'Your LinkedIn session expired',
    body: 'Campaigns are on hold until you reconnect. Nothing is lost – they continue where they stopped.',
    action: 'Reconnect LinkedIn',
  },
  error: {
    title: 'Your LinkedIn connection has a problem',
    body: 'Campaigns are on hold until you reconnect.',
    action: 'Reconnect LinkedIn',
  },
}

/** Warns when campaigns can't send because the LinkedIn account isn't usable. Renders nothing when connected. */
export function LinkedInNotice({ className }: { className?: string }) {
  const account = useLinkedInAccount()
  const status = account.data?.status
  if (!status || status === 'connected') return null
  const t = TEXT[status] ?? TEXT.error
  return (
    <Alert
      tone={status === 'disconnected' ? 'info' : 'warn'}
      icon={<LinkedInIcon size={18} />}
      title={t.title}
      className={className}
      action={
        <Link to="/connect" className="inline-flex h-8 items-center rounded-lg bg-brand px-3 text-sm font-semibold text-white hover:bg-brand-strong">
          {t.action}
        </Link>
      }
    >
      {t.body}
      {account.data?.lastError && status !== 'disconnected' && <span className="mt-1 block text-xs text-ink-3">{account.data.lastError}</span>}
    </Alert>
  )
}
