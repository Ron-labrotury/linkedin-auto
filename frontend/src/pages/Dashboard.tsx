import { Link, useNavigate } from 'react-router-dom'
import { Activity as ActivityIcon, ArrowRight, Check, Clock, Megaphone, Plus, Reply, UserCheck, UserPlus } from 'lucide-react'
import type { Dashboard as DashboardData, LimitUsage, LinkedInStatus } from '@shared/types.ts'
import { errorMessage } from '../api/client'
import { useCampaigns, useDashboard } from '../api/hooks-campaigns'
import { cn, pct } from '../lib/utils'
import { Button, Card, EmptyState, ErrorState, ProgressRing, Skeleton } from '../components/ui'
import { LinkedInIcon } from '../components/ui/LinkedInIcon'
import { CampaignTable } from '../components/CampaignTable'
import { ActivityList } from '../components/campaign/ActivityFeed'
import { engineStatus } from '../components/campaign/engineStatus'

const CONNECT_TEXT: Record<Exclude<LinkedInStatus, 'connected'>, { title: string; body: string; action: string }> = {
  disconnected: {
    title: 'Connect your LinkedIn account',
    body: 'Campaigns send invites and messages from your own LinkedIn account. Connect it to start – it takes a minute.',
    action: 'Connect LinkedIn',
  },
  needs_verification: {
    title: 'Finish connecting LinkedIn',
    body: 'LinkedIn asked for a verification code. Enter it to finish connecting your account.',
    action: 'Enter the code',
  },
  needs_app_approval: {
    title: 'Finish connecting LinkedIn',
    body: 'Approve the sign-in in your LinkedIn mobile app to finish connecting your account.',
    action: 'Continue',
  },
  expired: {
    title: 'Reconnect your LinkedIn account',
    body: 'Your LinkedIn session expired, so your campaigns are on hold. Reconnect and they continue where they stopped.',
    action: 'Reconnect LinkedIn',
  },
  error: {
    title: 'Reconnect your LinkedIn account',
    body: 'Something went wrong with your LinkedIn connection, so your campaigns are on hold.',
    action: 'Reconnect LinkedIn',
  },
}

function ConnectCard({ d }: { d: DashboardData }) {
  const status = d.linkedin.status
  if (status === 'connected') return null
  const t = CONNECT_TEXT[status] ?? CONNECT_TEXT.error
  return (
    <Card className={cn('flex flex-col gap-5 p-6 sm:flex-row sm:items-center sm:p-8', status === 'disconnected' ? 'border-brand/50 bg-brand-soft/40' : 'border-warn/50 bg-warn/10')}>
      <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-[#0a66c2] text-white" aria-hidden>
        <LinkedInIcon size={28} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-xl font-semibold">{t.title}</h2>
        <p className="mt-1 text-sm text-ink-2">{t.body}</p>
        {d.linkedin.lastError && status !== 'disconnected' && <p className="mt-1 text-xs text-ink-3">{d.linkedin.lastError}</p>}
      </div>
      <Link to="/connect" className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-lg bg-brand px-6 font-semibold text-white hover:bg-brand-strong">
        {t.action} <ArrowRight size={18} aria-hidden />
      </Link>
    </Card>
  )
}

function GetStarted({ connected }: { connected: boolean }) {
  const steps = [
    { done: connected, title: 'Connect your LinkedIn account', body: 'Your campaigns act through your own account.', to: '/connect', cta: 'Connect' },
    { done: false, title: 'Check your active hours', body: 'Pick the days and hours your account may work, and the random pause between actions.', to: '/settings#active-hours', cta: 'Open settings' },
    { done: false, title: 'Create your first campaign', body: 'Add leads, build your own sequence – invite, message, follow-up – and launch.', to: '/campaigns/new', cta: 'Create campaign' },
  ]
  return (
    <Card className="p-6 sm:p-10">
      <h2 className="text-2xl font-semibold">Get started</h2>
      <p className="mt-1 text-sm text-ink-2">Three steps to your first automated LinkedIn campaign.</p>
      <ol className="mt-6 grid gap-4 md:grid-cols-3">
        {steps.map((s, i) => (
          <li key={s.title} className={cn('flex flex-col rounded-xl border p-5', s.done ? 'border-ok/40 bg-ok/5' : 'border-line')}>
            <span className={cn('grid size-8 place-items-center rounded-full text-sm font-semibold', s.done ? 'bg-ok/20 text-ok' : 'bg-panel-2 text-ink-2')}>
              {s.done ? <Check size={16} aria-label="Done" /> : i + 1}
            </span>
            <p className="mt-3 font-semibold">{s.title}</p>
            <p className="mt-1 flex-1 text-sm text-ink-2">{s.body}</p>
            {!s.done && (
              <Link to={s.to} className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-brand hover:underline">
                {s.cta} <ArrowRight size={14} aria-hidden />
              </Link>
            )}
          </li>
        ))}
      </ol>
    </Card>
  )
}

function Ring({ label, usage }: { label: string; usage: LimitUsage }) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-2 text-center sm:gap-3">
      <ProgressRing value={pct(usage.done, usage.limit)} size={68} />
      <p className="text-base font-semibold tabular-nums sm:text-lg" title={usage.limit ? undefined : 'No active campaign sets a limit'}>
        {usage.done.toLocaleString('en-US')} <span className="font-normal text-ink-2">/ {usage.limit ? usage.limit.toLocaleString('en-US') : '–'}</span>
      </p>
      <p className="text-sm font-medium sm:text-base">{label}</p>
    </div>
  )
}

function Tile({ label, value, icon: Icon, hint }: { label: string; value: number; icon: typeof UserPlus; hint: string }) {
  return (
    <div className="rounded-xl border border-line p-5" title={hint}>
      <p className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ink-2">
        <Icon size={16} className="shrink-0 text-ink-3" aria-hidden /> {label}
      </p>
      <p className="mt-3 text-4xl font-medium tabular-nums">{value.toLocaleString('en-US')}</p>
      <p className="mt-1 text-xs text-ink-3">{hint}</p>
    </div>
  )
}

const TONE_DOT = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', idle: 'bg-ink-3' } as const

function DashboardSkeleton() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading dashboard">
      <div className="grid gap-8 2xl:grid-cols-[1fr_440px]">
        <Skeleton className="h-96" />
        <Skeleton className="h-96" />
      </div>
      <Skeleton className="h-64" />
    </div>
  )
}

export default function Dashboard() {
  const navigate = useNavigate()
  const dashboard = useDashboard()
  const campaigns = useCampaigns()

  if (dashboard.isPending) return <DashboardSkeleton />
  if (!dashboard.data) return <ErrorState title="Couldn’t load the dashboard" message={errorMessage(dashboard.error)} onRetry={() => void dashboard.refetch()} />

  const d = dashboard.data
  const all = campaigns.data ?? d.campaigns
  const activeCount = all.filter((c) => c.status === 'active').length
  const status = engineStatus(d, activeCount)
  const brandNew = all.length === 0 && d.activity.length === 0

  return (
    <div className="space-y-8">
      <ConnectCard d={d} />

      {brandNew ? (
        <GetStarted connected={d.linkedin.status === 'connected'} />
      ) : (
        <div className="grid gap-8 2xl:grid-cols-[1fr_440px]">
          <Card className="p-6 sm:p-10">
            <div className="mb-8 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold">Today’s activity</h2>
                <p className="mt-1 text-sm text-ink-3">Done today against the daily limits of your active campaigns</p>
              </div>
              <p className="flex items-center gap-2 rounded-full border border-line px-3 py-1.5 text-sm" role="status">
                <span className={cn('size-2.5 shrink-0 rounded-full', TONE_DOT[status.tone], status.tone === 'ok' && 'animate-pulse')} aria-hidden />
                {status.text}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2 sm:divide-x sm:divide-line">
              <Ring label="Invites sent" usage={d.today.invites} />
              <Ring label="Messages sent" usage={d.today.messages} />
              <Ring label="Profile views" usage={d.today.profileViews} />
            </div>
            <div className="mt-10 grid gap-4 md:grid-cols-3">
              <Tile label="Pending invites" value={d.pendingInvites} icon={UserPlus} hint="Invites sent but not accepted yet" />
              <Tile label="Accepted" value={d.accepted} icon={UserCheck} hint="Invites accepted, all campaigns" />
              <Tile label="Replies" value={d.replies} icon={Reply} hint="Leads who replied on LinkedIn" />
            </div>
            <p className="mt-6 flex items-start gap-2 text-xs text-ink-3">
              <Clock size={14} className="mt-px shrink-0" aria-hidden />
              <span>
                Actions run inside your <Link to="/settings#active-hours" className="text-brand hover:underline">active hours</Link>, with a random pause between each
                one.
              </span>
            </p>
          </Card>

          <Card className="flex max-h-[640px] flex-col p-6 sm:p-8">
            <h2 className="mb-2 text-xl font-semibold">Recent activity</h2>
            {d.activity.length ? (
              <div className="-mr-3 min-h-0 flex-1 overflow-y-auto pr-3">
                <ActivityList items={d.activity} />
              </div>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
                <span className="grid size-14 place-items-center rounded-2xl bg-panel-2 text-brand" aria-hidden><ActivityIcon size={26} /></span>
                <p className="mt-4 font-medium">No activity yet</p>
                <p className="mt-1 max-w-xs text-sm text-ink-2">Invites, messages and replies show up here as your campaigns run.</p>
              </div>
            )}
          </Card>
        </div>
      )}

      <Card className="p-6 sm:p-10">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <h2 className="text-2xl font-semibold">Recent campaigns</h2>
          <div className="flex flex-wrap gap-3">
            {d.campaigns.length > 0 && <Button variant="outline" onClick={() => navigate('/campaigns')}>All campaigns</Button>}
            <Button onClick={() => navigate('/campaigns/new')}><Plus size={16} /> New campaign</Button>
          </div>
        </div>
        {d.campaigns.length ? (
          <CampaignTable campaigns={d.campaigns} />
        ) : (
          <EmptyState
            icon={<Megaphone size={36} />}
            title="No campaigns yet"
            body="Create your first campaign: add leads, build your own sequence and let it run inside your active hours."
            action={<Button size="lg" onClick={() => navigate('/campaigns/new')}><Plus size={18} /> Create your first campaign</Button>}
          />
        )}
      </Card>
    </div>
  )
}
