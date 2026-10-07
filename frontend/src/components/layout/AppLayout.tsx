import { useState } from 'react'
import { NavLink, Outlet, Link } from 'react-router-dom'
import {
  LayoutGrid,
  Megaphone,
  Mail,
  Sparkles,
  Users,
  Settings,
  ChevronDown,
  ListCollapse,
  Menu,

} from 'lucide-react'
import { LinkedInIcon as Linkedin } from '../ui/LinkedInIcon'
import { cn } from '../../lib/utils'
import { useStore } from '../../store/useStore'
import { Avatar, Toaster } from '../ui'

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutGrid, end: true },
  { to: '/campaigns', label: 'Campaigns', icon: Megaphone },
  { to: '/inbox', label: 'Inbox', icon: Mail },
  { to: '/leads', label: 'Leads', icon: Sparkles },
  { to: '/teams', label: 'Teams', icon: Users },
  { to: '/settings', label: 'Settings', icon: Settings },
]

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <Link to="/" className="flex items-center gap-2.5">
      <span className="grid size-9 place-items-center rounded-xl bg-brand text-white">
        <Linkedin size={20} />
      </span>
      {!compact && <span className="text-2xl font-bold tracking-tight">LinkPilot</span>}
    </Link>
  )
}

function Sidebar({ collapsed, onToggle, onNavigate }: { collapsed: boolean; onToggle: () => void; onNavigate?: () => void }) {
  const account = useStore((s) => s.account)
  const unread = useStore((s) => s.conversations.filter((c) => c.unread).length)
  const campaigns = useStore((s) => s.campaigns.length)
  const setupDone = [account.connected, campaigns > 0, true, false, false].filter(Boolean).length

  return (
    <aside className={cn('flex h-full flex-col gap-6 overflow-y-auto bg-sidebar px-5 py-7', collapsed ? 'w-24' : 'w-72')}>
      <div className={cn('flex items-center', collapsed ? 'flex-col gap-4' : 'justify-between')}>
        <Logo compact={collapsed} />
        <button onClick={onToggle} className="hidden cursor-pointer rounded-md p-1 text-ink-2 hover:text-ink lg:block" aria-label="Collapse sidebar">
          <ListCollapse size={20} className={cn(collapsed && 'rotate-180')} />
        </button>
      </div>

      <Link to="/settings" onClick={onNavigate} className={cn('flex items-center gap-3 rounded-xl p-1', collapsed && 'justify-center')}>
        <span className="relative">
          <Avatar name={account.name} size={48} />
          <span className={cn('absolute -bottom-0.5 -right-0.5 size-4 rounded-full border-2 border-sidebar', account.connected ? 'bg-ok' : 'bg-bad')} />
        </span>
        {!collapsed && (
          <>
            <span className="flex-1 truncate text-lg font-medium text-brand">{account.name}</span>
            <ChevronDown size={18} className="text-brand" />
          </>
        )}
      </Link>

      {!collapsed && (
        <Link to="/settings" onClick={onNavigate} className="block rounded-xl bg-panel p-4">
          <p className="text-sm font-semibold">Finish set-up</p>
          <div className="mt-3 h-1.5 rounded-full bg-line">
            <div className="h-full rounded-full bg-brand" style={{ width: `${(setupDone / 5) * 100}%` }} />
          </div>
          <div className="mt-2.5 flex justify-between text-xs">
            <span className="font-medium">{setupDone}/5 completed</span>
            <span className="text-ink-3">Skip guide</span>
          </div>
        </Link>
      )}

      <nav className="flex flex-col gap-1">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={onNavigate}
            title={label}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-4 rounded-xl px-4 py-3 text-[17px] font-medium transition-colors',
                collapsed && 'justify-center px-0',
                isActive ? 'bg-brand-soft text-brand' : 'text-ink hover:bg-panel',
              )
            }
          >
            <Icon size={22} strokeWidth={1.75} />
            {!collapsed && <span className="flex-1">{label}</span>}
            {!collapsed && label === 'Inbox' && unread > 0 && (
              <span className="grid min-w-5 place-items-center rounded-full bg-accent px-1.5 text-xs font-bold text-white">{unread}</span>
            )}
          </NavLink>
        ))}
      </nav>

      {!collapsed && (
        <div className="mt-auto rounded-2xl border border-line bg-panel/60 p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-semibold">Free trial</p>
              <p className="mt-1 text-xs font-medium text-accent">7 days left</p>
            </div>
            <span className="grid size-14 place-items-center rounded-full border-2 border-accent text-sm font-semibold">7d</span>
          </div>
          <button className="mt-5 h-11 w-full cursor-pointer rounded-xl bg-brand font-semibold text-white hover:bg-brand-strong">Upgrade</button>
        </div>
      )}
    </aside>
  )
}

export default function AppLayout() {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className="flex h-full">
      <div className="hidden h-full shrink-0 lg:block">
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
      </div>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-bg/70" onClick={() => setMobileOpen(false)} />
          <div className="relative h-full w-72">
            <Sidebar collapsed={false} onToggle={() => setMobileOpen(false)} onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      )}

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-sidebar px-4 py-3 lg:hidden">
          <button onClick={() => setMobileOpen(true)} className="cursor-pointer p-1" aria-label="Open menu">
            <Menu size={22} />
          </button>
          <Logo />
        </div>
        <div className="mx-auto max-w-[1500px] p-4 sm:p-6 lg:p-10">
          <Outlet />
        </div>
      </main>
      <Toaster />
    </div>
  )
}
