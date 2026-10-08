import { Suspense, useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, Link, useLocation } from 'react-router-dom'
import { LayoutGrid, Megaphone, Users, Settings, ListCollapse, Menu, LogOut, Check, ChevronRight, AlertTriangle, X } from 'lucide-react'
import type { LinkedInAccount } from '@shared/types.ts'
import { cn } from '../../lib/utils'
import { useAuth } from '../../auth/context'
import { useCampaignSummaries, useLinkedIn } from '../../api/hooks-account'
import { Spinner } from '../ui'
import { LINKEDIN_STATUS, StatusDot, isPendingLogin } from '../linkedin/status'
import { ProfilePhoto } from '../linkedin/ProfilePhoto'
import { ErrorBoundary } from './ErrorBoundary'
import { Logo } from './Logo'
import { setupSteps } from './setup'

export { Logo }

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutGrid, end: true },
  { to: '/campaigns', label: 'Campaigns', icon: Megaphone },
  { to: '/teams', label: 'Teams', icon: Users },
  { to: '/settings', label: 'Settings', icon: Settings },
]

const COLLAPSED_KEY = 'linkpilot.sidebarCollapsed'

function AccountBlock({ collapsed, account, onNavigate }: { collapsed: boolean; account: LinkedInAccount | undefined; onNavigate?: () => void }) {
  const { user } = useAuth()
  const name = user?.name ?? ''
  const status = account?.status
  const statusText = status ? (status === 'connected' ? 'LinkedIn connected' : `LinkedIn: ${LINKEDIN_STATUS[status].label.toLowerCase()}`) : 'Checking LinkedIn…'
  return (
    <Link
      to="/settings"
      onClick={onNavigate}
      title={collapsed ? `${name} – ${statusText}` : undefined}
      aria-label={`${name}, ${statusText}. Open settings`}
      className={cn('flex items-center gap-3 rounded-xl p-1.5 transition-colors hover:bg-panel', collapsed && 'justify-center')}
    >
      <span className="relative">
        <ProfilePhoto name={name} src={status === 'connected' ? account?.profile?.imageUrl : null} size={44} />
        <StatusDot status={status} className="absolute -bottom-0.5 -right-0.5 size-3.5 border-2 border-sidebar" />
      </span>
      {!collapsed && (
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold text-ink">{name}</span>
          <span className={cn('block truncate text-xs', status === 'connected' ? 'text-ok' : status && isPendingLogin(status) ? 'text-warn' : status ? 'text-bad' : 'text-ink-3')}>
            {statusText}
          </span>
        </span>
      )}
    </Link>
  )
}

function SetupChecklist({ account, onNavigate }: { account: LinkedInAccount | undefined; onNavigate?: () => void }) {
  const campaigns = useCampaignSummaries()
  if (!account || !campaigns.data) return null
  const steps = setupSteps(account, campaigns.data)
  const done = steps.filter((s) => s.done).length
  if (done === steps.length) return null
  return (
    <section aria-labelledby="setup-title" className="rounded-xl bg-panel p-4">
      <div className="flex items-baseline justify-between">
        <h2 id="setup-title" className="text-sm font-semibold">Finish set-up</h2>
        <span className="text-xs font-medium text-ink-3">{done}/{steps.length} completed</span>
      </div>
      <div className="mt-3 h-1.5 rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done} aria-label="Set-up progress">
        <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${(done / steps.length) * 100}%` }} />
      </div>
      <ol className="mt-3 space-y-0.5">
        {steps.map((s) => (
          <li key={s.id}>
            {s.done ? (
              <span className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-sm text-ink-3 line-through decoration-ink-3/60">
                <span className="grid size-5 place-items-center rounded-full bg-ok/20 text-ok">
                  <Check size={12} strokeWidth={3} aria-hidden />
                </span>
                {s.label}
                <span className="sr-only">(done)</span>
              </span>
            ) : (
              <Link to={s.to} onClick={onNavigate} className="group flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-sm font-medium text-ink hover:bg-panel-2">
                <span className="size-5 rounded-full border-2 border-line-strong" aria-hidden />
                <span className="flex-1">{s.label}</span>
                <ChevronRight size={16} className="text-ink-3 group-hover:text-ink" aria-hidden />
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}

function Sidebar({
  collapsed,
  onToggle,
  onNavigate,
  mobile,
  account,
}: {
  collapsed: boolean
  onToggle: () => void
  onNavigate?: () => void
  mobile?: boolean
  account: LinkedInAccount | undefined
}) {
  const { logout } = useAuth()
  return (
    <aside className={cn('flex h-full flex-col gap-6 overflow-y-auto bg-sidebar px-4 py-6', collapsed ? 'w-24 items-stretch' : 'w-72')}>
      <div className={cn('flex items-center px-1', collapsed ? 'flex-col gap-4' : 'justify-between')}>
        <Logo compact={collapsed} />
        {mobile ? (
          <button onClick={onToggle} className="cursor-pointer rounded-md p-1 text-ink-2 hover:text-ink" aria-label="Close menu">
            <X size={22} />
          </button>
        ) : (
          <button
            onClick={onToggle}
            className="cursor-pointer rounded-md p-1 text-ink-2 hover:text-ink"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
          >
            <ListCollapse size={20} className={cn(collapsed && 'rotate-180')} />
          </button>
        )}
      </div>

      <AccountBlock collapsed={collapsed} account={account} onNavigate={onNavigate} />

      {!collapsed && <SetupChecklist account={account} onNavigate={onNavigate} />}

      <nav aria-label="Main" className="flex flex-col gap-1">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={onNavigate}
            title={collapsed ? label : undefined}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-4 rounded-xl px-4 py-3 text-[17px] font-medium transition-colors',
                collapsed && 'justify-center px-0',
                isActive ? 'bg-brand-soft text-brand' : 'text-ink hover:bg-panel',
              )
            }
          >
            <Icon size={22} strokeWidth={1.75} aria-hidden />
            {collapsed ? <span className="sr-only">{label}</span> : <span className="flex-1">{label}</span>}
          </NavLink>
        ))}
      </nav>

      <button
        onClick={() => void logout()}
        title={collapsed ? 'Sign out' : undefined}
        className={cn(
          'mt-auto flex cursor-pointer items-center gap-4 rounded-xl px-4 py-3 text-[15px] font-medium text-ink-2 transition-colors hover:bg-panel hover:text-ink',
          collapsed && 'justify-center px-0',
        )}
      >
        <LogOut size={20} strokeWidth={1.75} aria-hidden />
        {collapsed ? <span className="sr-only">Sign out</span> : 'Sign out'}
      </button>
    </aside>
  )
}

function LinkedInBanner({ account }: { account: LinkedInAccount }) {
  if (account.status === 'connected') return null
  const pending = isPendingLogin(account.status)
  // 'error': LinkedIn reported a problem with the account (e.g. not in English) – show what it was
  const problem = account.status === 'error'
  const text = pending
    ? 'Finish connecting LinkedIn — it’s waiting for you to verify the sign-in. Campaigns wait until it’s connected.'
    : account.status === 'expired'
      ? 'Your LinkedIn session expired. Reconnect your LinkedIn account to keep sending — campaigns wait until it’s connected.'
      : problem
        ? `Your LinkedIn account needs attention — campaigns are on hold until it’s fixed.${account.lastError ? ` ${account.lastError}` : ''}`
        : 'Connect your LinkedIn account to start sending — campaigns wait until it’s connected.'
  return (
    <div role="status" className={cn('border-b px-4 py-3 sm:px-6 lg:px-10', pending ? 'border-warn/30 bg-warn/10' : 'border-bad/30 bg-bad/10')}>
      <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-4 gap-y-2">
        <AlertTriangle size={18} className={cn('shrink-0', pending ? 'text-warn' : 'text-bad')} aria-hidden />
        <p className="min-w-0 flex-1 text-sm font-medium text-ink">{text}</p>
        <Link
          to={problem ? '/settings#linkedin' : '/connect'}
          className="inline-flex h-8 shrink-0 items-center rounded-lg bg-brand px-3 text-sm font-semibold text-white transition-colors hover:bg-brand-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          {pending ? 'Finish connecting' : account.status === 'expired' ? 'Reconnect' : problem ? 'Review in Settings' : 'Connect LinkedIn'}
        </Link>
      </div>
    </div>
  )
}

function PageLoader() {
  return (
    <div className="grid place-items-center py-24" role="status" aria-live="polite">
      <Spinner size={28} className="text-brand" label="Loading page" />
    </div>
  )
}

export default function AppLayout() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  const [mobileOpen, setMobileOpen] = useState(false)
  const { pathname } = useLocation()
  const mainRef = useRef<HTMLElement>(null)
  // poll so the banner notices when the engine finds the session expired
  const linkedin = useLinkedIn({ refetchInterval: 60_000 })
  const account = linkedin.data

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
    } catch {
      /* not persisted */
    }
  }, [collapsed])

  // the page scrolls inside <main>, so reset it on navigation (pages handle their own #anchors); also close the drawer
  useEffect(() => {
    if (!window.location.hash) mainRef.current?.scrollTo({ top: 0 })
    setMobileOpen(false)
  }, [pathname])

  useEffect(() => {
    if (!mobileOpen) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMobileOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mobileOpen])

  return (
    <div className="flex h-full">
      <div className="hidden h-full shrink-0 lg:block">
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} account={account} />
      </div>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-bg/70 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
          <div className="relative h-full w-72 max-w-[85vw] shadow-2xl">
            <Sidebar collapsed={false} mobile onToggle={() => setMobileOpen(false)} onNavigate={() => setMobileOpen(false)} account={account} />
          </div>
        </div>
      )}

      <main ref={mainRef} className="min-w-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-sidebar px-4 py-3 lg:hidden">
          <button onClick={() => setMobileOpen(true)} className="cursor-pointer p-1" aria-label="Open menu" aria-expanded={mobileOpen}>
            <Menu size={22} />
          </button>
          <Logo />
          <Link to="/settings" className="ml-auto flex items-center gap-2 rounded-lg p-1 text-xs text-ink-2" aria-label="LinkedIn status – open settings">
            <StatusDot status={account?.status} />
            <span className="hidden min-[400px]:inline">{account ? LINKEDIN_STATUS[account.status].label : ''}</span>
          </Link>
        </div>
        {account && <LinkedInBanner account={account} />}
        <div className="mx-auto max-w-[1500px] p-4 sm:p-6 lg:p-10">
          <ErrorBoundary key={pathname}>
            <Suspense fallback={<PageLoader />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </div>
      </main>
    </div>
  )
}
