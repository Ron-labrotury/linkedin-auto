import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Eye, MessageSquare, Mail, UserCheck, UserPlus, Reply, Megaphone } from 'lucide-react'
import type { Activity } from '../types'
import { useStore, toast } from '../store/useStore'
import { Button, Card, EmptyState, Modal, ProgressRing, Select } from '../components/ui'
import { CampaignTable } from '../components/CampaignTable'
import { formatDateTime, pct } from '../lib/utils'
import { MOCK_PROFILE_VIEWS_DELTA } from '../data/mock'

const ACTIVITY_TEXT: Record<Activity['type'], { text: string; icon: typeof Eye }> = {
  invite: { text: 'Connection request was sent to', icon: UserPlus },
  accepted: { text: 'Connection request was accepted by', icon: UserCheck },
  message: { text: 'Message was sent to', icon: MessageSquare },
  reply: { text: 'New reply from', icon: Reply },
  view: { text: 'Profile was viewed:', icon: Eye },
  email: { text: 'Email was sent to', icon: Mail },
  follow: { text: 'Followed', icon: UserPlus },
}

function WithdrawModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pending = useStore((s) => s.pendingInvites)
  const withdraw = useStore((s) => s.withdrawInvites)
  const [olderThan, setOlderThan] = useState('30')
  // Demo estimate: older invites make up a larger share of the pending pile.
  const estimate = Math.round(pending * ({ '14': 0.8, '30': 0.6, '60': 0.35, '90': 0.2 }[olderThan] ?? 0.5))
  return (
    <Modal open={open} onClose={onClose} className="max-w-lg">
      <h3 className="text-xl font-semibold">Withdraw pending invitations</h3>
      <p className="mt-2 text-sm text-ink-2">
        LinkedIn limits how many invitations can be pending. Withdrawing old ones frees up room for new campaigns.
      </p>
      <div className="mt-6 space-y-2">
        <label className="text-sm font-medium text-ink-2" htmlFor="older">Withdraw invitations older than</label>
        <Select id="older" value={olderThan} onChange={(e) => setOlderThan(e.target.value)}>
          <option value="14">2 weeks</option>
          <option value="30">1 month</option>
          <option value="60">2 months</option>
          <option value="90">3 months</option>
        </Select>
        <p className="text-sm text-ink-3">About <span className="font-semibold text-ink">{estimate}</span> of {pending} pending invitations match.</p>
      </div>
      <div className="mt-8 flex justify-end gap-3">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button
          disabled={estimate === 0}
          onClick={() => {
            withdraw(estimate)
            toast(`${estimate} invitations queued for withdrawal`, 'success')
            onClose()
          }}
        >
          Withdraw {estimate}
        </Button>
      </div>
    </Modal>
  )
}

export default function Dashboard() {
  const navigate = useNavigate()
  const { campaigns, activity, conversations, pendingInvites, account } = useStore()
  const [withdrawOpen, setWithdrawOpen] = useState(false)

  const today = useMemo(() => {
    const active = campaigns.filter((c) => c.status === 'active')
    const limit = (k: 'dailyInvites' | 'dailyMessages' | 'dailyEmails' | 'dailyProfileViews') =>
      active.length ? Math.max(...active.map((c) => c.settings[k])) : 0
    const sum = (k: 'invitesSent' | 'messagesSent' | 'emailsSent' | 'profileViews') =>
      active.reduce((a, c) => a + c.stats[k], 0)
    return [
      { label: 'Invites sent', done: Math.min(sum('invitesSent'), limit('dailyInvites')), limit: limit('dailyInvites') },
      { label: 'Messages sent', done: Math.min(sum('messagesSent'), limit('dailyMessages')), limit: limit('dailyMessages') },
      { label: 'Emails sent', done: Math.min(sum('emailsSent'), limit('dailyEmails')), limit: limit('dailyEmails') },
      { label: 'Profile viewed', done: Math.min(sum('profileViews'), limit('dailyProfileViews')), limit: limit('dailyProfileViews') },
    ]
  }, [campaigns])

  const unread = conversations.filter((c) => c.unread).length

  return (
    <div className="space-y-8">
      <div className="grid gap-8 xl:grid-cols-[1fr_480px]">
        <Card className="p-6 sm:p-10">
          <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">Today’s activity</h2>
              <p className="mt-1 text-sm text-ink-3">Progress against your daily limits across active campaigns</p>
            </div>
            {!account.connected && (
              <Link to="/settings" className="text-sm font-medium text-accent">Connect LinkedIn to start sending →</Link>
            )}
          </div>
          <div className="grid grid-cols-2 gap-y-8 md:grid-cols-4 md:divide-x md:divide-line">
            {today.map((m) => (
              <div key={m.label} className="flex flex-col items-center gap-3">
                <ProgressRing value={pct(m.done, m.limit)} />
                <p className="text-lg font-semibold tabular-nums">
                  {m.done} <span className="font-normal text-ink-2">/ {m.limit}</span>
                </p>
                <p className="font-medium">{m.label}</p>
              </div>
            ))}
          </div>
          <div className="mt-10 grid gap-4 md:grid-cols-[1.35fr_1fr_1fr]">
            <div className="rounded-xl border border-line p-5">
              <p className="text-sm font-semibold uppercase tracking-wide text-ink-2">Pending invitations</p>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <span className="text-4xl font-medium tabular-nums">{pendingInvites}</span>
                <Button variant="outline" onClick={() => setWithdrawOpen(true)} disabled={pendingInvites === 0}>
                  Withdraw
                </Button>
              </div>
            </div>
            <Link to="/inbox" className="rounded-xl border border-line p-5 hover:border-line-strong">
              <p className="text-sm font-semibold uppercase tracking-wide text-ink-2">Unread messages</p>
              <p className="mt-4 text-4xl font-medium tabular-nums">{unread}</p>
            </Link>
            <div className="rounded-xl border border-line p-5">
              <p className="text-sm font-semibold uppercase tracking-wide text-ink-2">Profile views since last week</p>
              <p className="mt-4 text-4xl font-medium tabular-nums">+{MOCK_PROFILE_VIEWS_DELTA} %</p>
            </div>
          </div>
        </Card>

        <Card className="flex max-h-[560px] flex-col p-6 sm:p-8">
          <h2 className="mb-4 text-xl font-semibold">Recent activity</h2>
          <ul className="-mr-3 flex-1 overflow-y-auto pr-3">
            {activity.map((a) => {
              const { text, icon: Icon } = ACTIVITY_TEXT[a.type]
              return (
                <li key={a.id} className="flex gap-4 border-b border-line py-5 last:border-0">
                  <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg border border-line-strong text-ink-2">
                    <Icon size={18} />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[15px] leading-snug">
                      {text} <span className="text-brand">{a.leadName}</span>
                    </p>
                    <p className="mt-1.5 text-sm text-ink-2">
                      {formatDateTime(a.at)} •{' '}
                      <Link to={`/campaigns/${a.campaignId}`} className="text-brand hover:underline">{a.campaignName}</Link>
                    </p>
                  </div>
                </li>
              )
            })}
          </ul>
        </Card>
      </div>

      <Card className="p-6 sm:p-10">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <h2 className="text-2xl font-semibold">Recent campaigns</h2>
          <div className="flex gap-3">
            <Button variant="outline" size="lg" onClick={() => navigate('/campaigns')}>All campaigns</Button>
            <Button size="lg" onClick={() => navigate('/campaigns/new')}>New campaign</Button>
          </div>
        </div>
        {campaigns.length ? (
          <CampaignTable campaigns={campaigns.slice(0, 5)} />
        ) : (
          <EmptyState
            icon={<Megaphone size={36} />}
            title="No campaigns yet"
            body="Create your first campaign: add leads, build a sequence, and let it run on autopilot."
            action={<Button size="lg" onClick={() => navigate('/campaigns/new')}>Create campaign</Button>}
          />
        )}
      </Card>

      <WithdrawModal open={withdrawOpen} onClose={() => setWithdrawOpen(false)} />
    </div>
  )
}
