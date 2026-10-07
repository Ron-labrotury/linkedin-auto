import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, Info, Trash2 } from 'lucide-react'
import type { Campaign } from '../types'
import { useStore, toast } from '../store/useStore'
import { cn, formatDate, pct } from '../lib/utils'
import { ConfirmModal, Toggle } from './ui'

function Metric({ label, value, hint, accent }: { label: string; value: string | number; hint?: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex items-center gap-1.5 text-sm font-medium" title={hint}>
        {label}
        {hint && <Info size={14} className="text-ink-3" />}
      </span>
      <span className={cn('text-lg font-medium tabular-nums', accent ? 'text-brand' : 'text-ink')}>{value}</span>
    </div>
  )
}

function CampaignRow({ c }: { c: Campaign }) {
  const toggle = useStore((s) => s.toggleCampaign)
  const remove = useStore((s) => s.deleteCampaign)
  const [confirm, setConfirm] = useState(false)
  const total = c.leadIds.length
  const contactedPct = pct(c.contacted, total)
  const noSteps = !c.sequence.rootId

  return (
    <div className="grid grid-cols-1 gap-x-10 gap-y-5 border-t border-line py-7 md:grid-cols-2 xl:grid-cols-[1.2fr_1fr_1fr_1fr_auto]">
      <div className="min-w-0">
        <div className="flex items-center justify-between gap-3">
          <Link to={`/campaigns/${c.id}`} className="flex min-w-0 items-center gap-1.5 text-lg font-medium hover:text-brand">
            <span className="truncate">{c.name}</span>
            <ChevronRight size={18} className="shrink-0" />
          </Link>
          {(noSteps || total === 0) && (
            <span title={noSteps ? 'This campaign has no sequence steps' : 'This campaign has no leads'} className="text-accent">
              <Info size={20} />
            </span>
          )}
        </div>
        <div className="mt-3 flex h-1 gap-1.5">
          <div className="rounded-full bg-accent" style={{ width: `${Math.max(contactedPct, total ? 2 : 0)}%` }} />
          <div className="flex-1 rounded-full bg-accent/50" />
        </div>
        <div className="mt-2 flex gap-8 text-sm font-semibold">
          <span className="text-accent" title="Contacted">{c.contacted}</span>
          <span className="text-accent/70" title="Remaining">{total - c.contacted}</span>
        </div>
      </div>

      <div className="space-y-3">
        <Metric label="All leads" value={total} accent />
        <Metric label="Contacted" value={c.contacted} hint="Leads that received at least one action" accent />
      </div>

      <div className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-wider text-ink-3 xl:hidden">LinkedIn</p>
        <Metric label="Accepted" value={`${pct(c.stats.accepted, c.stats.invitesSent)}%`} />
        <Metric label="Replied" value={`${pct(c.stats.replied, c.stats.messagesSent)}%`} hint="Reply rate on LinkedIn messages" />
      </div>

      <div className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-wider text-ink-3 xl:hidden">Email</p>
        <Metric label="Delivered" value={`${c.stats.emailsSent ? 100 : 0}%`} hint="Delivery rate (bounce tracking arrives with the backend)" />
        <Metric label="Replied" value={`${pct(c.stats.emailsReplied, c.stats.emailsSent)}%`} hint="Reply rate on emails" />
      </div>

      <div className="flex items-start justify-between gap-6 xl:flex-col xl:items-end xl:justify-start xl:gap-3">
        <div className="flex items-center gap-4">
          <Toggle
            checked={c.status === 'active'}
            label={`Toggle ${c.name}`}
            onChange={() => {
              if (c.status !== 'active' && (noSteps || total === 0)) {
                toast(noSteps ? 'Add at least one step to the sequence first' : 'Add leads before starting the campaign', 'error')
                return
              }
              toggle(c.id)
              toast(c.status === 'active' ? 'Campaign paused' : 'Campaign started', 'success')
            }}
          />
          <button onClick={() => setConfirm(true)} className="cursor-pointer text-ink-2 hover:text-bad" aria-label="Delete campaign">
            <Trash2 size={20} />
          </button>
        </div>
        <span className="text-ink-2">{formatDate(c.createdAt)}</span>
      </div>

      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete campaign?"
        body={<>“{c.name}” will stop immediately and its leads will be unassigned. This can’t be undone.</>}
        onConfirm={() => {
          remove(c.id)
          toast('Your campaign has been successfully removed')
        }}
      />
    </div>
  )
}

export function CampaignTable({ campaigns }: { campaigns: Campaign[] }) {
  return (
    <div>
      <div className="hidden grid-cols-[1.2fr_1fr_1fr_1fr_auto] gap-x-10 pb-5 text-[15px] font-medium text-ink-2 xl:grid">
        <span>Overview</span>
        <span>Leads</span>
        <span>LinkedIn</span>
        <span>Email</span>
        <span className="w-24 text-right">Status</span>
      </div>
      {campaigns.map((c) => (
        <CampaignRow key={c.id} c={c} />
      ))}
    </div>
  )
}
