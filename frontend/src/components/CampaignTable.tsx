import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ChevronRight, Info, LoaderCircle, Trash2 } from 'lucide-react'
import type { CampaignStatus, CampaignSummary } from '@shared/types.ts'
import { errorMessage } from '../api/client'
import { useDeleteCampaign, useUpdateCampaign } from '../api/hooks-campaigns'
import { toast } from '../lib/toast'
import { cn, formatDate, pct } from '../lib/utils'
import { Badge, ConfirmModal, Toggle, type BadgeTone } from './ui'

export const CAMPAIGN_STATUS: Record<CampaignStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  active: { label: 'Active', tone: 'ok' },
  paused: { label: 'Paused', tone: 'warn' },
  completed: { label: 'Completed', tone: 'info' },
}

function Metric({ label, value, hint, accent }: { label: string; value: string | number; hint?: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex items-center gap-1.5 text-sm font-medium text-ink-2" title={hint}>
        {label}
        {hint && <Info size={14} className="text-ink-3" aria-hidden />}
      </span>
      <span className={cn('text-lg font-medium tabular-nums', accent ? 'text-brand' : 'text-ink')}>{value}</span>
    </div>
  )
}

/**
 * Start / pause with the server's rules; refusals (422) are shown as a toast. Every call reports its
 * own result (mutateAsync), even when several campaigns are toggled before the first answer arrives –
 * per-call mutate() callbacks would only fire for the latest call of a shared mutation.
 */
export function useToggleCampaign() {
  const update = useUpdateCampaign()
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const pendingRef = useRef(pending)
  pendingRef.current = pending

  const toggle = async (c: Pick<CampaignSummary, 'id' | 'status' | 'stepCount'>) => {
    const starting = c.status !== 'active'
    if (starting && c.stepCount === 0) return toast('Add at least one step to the sequence before starting the campaign', 'error')
    if (pendingRef.current.has(c.id)) return
    const mark = (on: boolean) =>
      setPending((s) => {
        const next = new Set(s)
        if (on) next.add(c.id)
        else next.delete(c.id)
        return next
      })
    mark(true)
    try {
      await update.mutateAsync({ id: c.id, patch: { status: starting ? 'active' : 'paused' } })
      toast(starting ? 'Campaign started' : 'Campaign paused', 'success')
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      mark(false)
    }
  }
  const isPending = (id: string) => pending.has(id)
  return { toggle, isPending }
}

function CampaignRow({ c }: { c: CampaignSummary }) {
  // one mutation per row: each row's switch tracks and reports its own request
  const { toggle, isPending } = useToggleCampaign()
  const pending = isPending(c.id)
  const remove = useDeleteCampaign()
  const [confirm, setConfirm] = useState(false)
  const s = c.stats
  const total = s.totalLeads
  const contactedPct = pct(s.contacted, total)
  const noSteps = c.stepCount === 0
  const noLeads = total === 0 && c.pendingImports === 0
  const status = CAMPAIGN_STATUS[c.status]
  const active = c.status === 'active'

  return (
    <div className="grid grid-cols-1 gap-x-10 gap-y-5 border-t border-line py-7 md:grid-cols-2 xl:grid-cols-[1.4fr_1fr_1fr_auto]">
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <Link to={`/campaigns/${c.id}`} className="flex min-w-0 items-center gap-1.5 text-lg font-medium hover:text-brand">
            <span className="truncate">{c.name}</span>
            <ChevronRight size={18} className="shrink-0" aria-hidden />
          </Link>
          {(noSteps || noLeads) && (
            <span title={noSteps ? 'The sequence has no steps yet' : 'This campaign has no leads yet'} className="shrink-0 text-accent">
              <AlertTriangle size={18} aria-label={noSteps ? 'No steps yet' : 'No leads yet'} />
            </span>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {c.status !== 'active' && <Badge tone={status.tone}>{status.label}</Badge>}
          {c.pendingImports > 0 && (
            <Badge tone="info">
              <LoaderCircle size={12} className={cn(active && 'animate-spin')} aria-hidden /> {active ? 'Collecting leads' : 'Search waiting'}
            </Badge>
          )}
        </div>
        <div
          className="mt-3 flex h-1.5 gap-1.5"
          role="progressbar"
          aria-label="Leads contacted"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={s.contacted}
        >
          <div className="rounded-full bg-accent transition-[width]" style={{ width: `${Math.max(contactedPct, total ? 2 : 0)}%` }} />
          <div className="flex-1 rounded-full bg-accent/30" />
        </div>
        <div className="mt-2 flex gap-6 text-sm font-semibold">
          <span className="text-accent">{s.contacted.toLocaleString('en-US')} contacted</span>
          <span className="text-ink-3">{(total - s.contacted).toLocaleString('en-US')} remaining</span>
        </div>
      </div>

      <div className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-wider text-ink-3 xl:hidden">Leads</p>
        <Metric label="All leads" value={total.toLocaleString('en-US')} accent />
        <Metric label="Contacted" value={s.contacted.toLocaleString('en-US')} hint="Leads that received at least one action" accent />
      </div>

      <div className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-wider text-ink-3 xl:hidden">LinkedIn</p>
        <Metric label="Invites sent" value={s.invitesSent.toLocaleString('en-US')} />
        <Metric label="Accepted" value={`${pct(s.accepted, s.invitesSent)}%`} hint="Share of sent invites that were accepted" />
        <Metric label="Replied" value={`${pct(s.replied, s.contacted)}%`} hint="Share of contacted leads who replied on LinkedIn" />
      </div>

      <div className="flex items-start justify-between gap-6 xl:flex-col xl:items-end xl:justify-start xl:gap-3">
        <div className="flex items-center gap-4">
          <span className={cn('inline-flex', pending && 'pointer-events-none opacity-60')} aria-busy={pending || undefined}>
            <Toggle checked={active} label={`${active ? 'Pause' : 'Start'} campaign ${c.name}`} onChange={() => void toggle(c)} />
          </span>
          <button
            type="button"
            onClick={() => setConfirm(true)}
            disabled={remove.isPending}
            className="cursor-pointer rounded-md p-1 text-ink-2 hover:text-bad disabled:opacity-50"
            aria-label={`Delete campaign ${c.name}`}
            title="Delete campaign"
          >
            <Trash2 size={20} />
          </button>
        </div>
        <span className="text-sm text-ink-2">Created {formatDate(c.createdAt)}</span>
      </div>

      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete campaign?"
        body={<>“{c.name}” stops immediately and its {total.toLocaleString('en-US')} leads are deleted. Its activity log stays. This can’t be undone.</>}
        onConfirm={() =>
          remove.mutate(c.id, {
            onSuccess: () => toast('Campaign deleted', 'success'),
            onError: (e) => toast(errorMessage(e), 'error'),
          })
        }
      />
    </div>
  )
}

export function CampaignTable({ campaigns }: { campaigns: CampaignSummary[] }) {
  return (
    <div>
      <div className="hidden grid-cols-[1.4fr_1fr_1fr_auto] gap-x-10 pb-5 text-[15px] font-medium text-ink-2 xl:grid" aria-hidden>
        <span>Overview</span>
        <span>Leads</span>
        <span>LinkedIn</span>
        <span className="w-28 text-right">Status</span>
      </div>
      {campaigns.map((c) => (
        <CampaignRow key={c.id} c={c} />
      ))}
    </div>
  )
}
