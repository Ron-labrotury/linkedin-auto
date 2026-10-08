import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, ExternalLink, Plus, Search, Trash2, Users } from 'lucide-react'
import type { Campaign, Lead, LeadStatus } from '@shared/types.ts'
import { errorMessage } from '../../../api/client'
import { useAddLeads, useDeleteLeads, useLeads } from '../../../api/hooks-campaigns'
import { toast } from '../../../lib/toast'
import { stepNumbers, stepTitle } from '../../../lib/sequence'
import { cn, formatDateTime, plural, timeAgo, timeUntil } from '../../../lib/utils'
import { Avatar, Button, ConfirmModal, EmptyState, ErrorState, Input, Select, Skeleton } from '../../../components/ui'
import { LEAD_STATUSES, LEAD_STATUS_LABEL, LeadStatusBadge } from '../../../components/LeadStatusBadge'
import { AddLeadsModal, type AddLeadsResult } from '../../../components/campaign/AddLeadsModal'

const PAGE = 50

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

function SelectBox({ checked, indeterminate, onChange, label }: { checked: boolean; indeterminate?: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = !!indeterminate
      }}
      onChange={(e) => onChange(e.target.checked)}
      className="size-4 cursor-pointer accent-[var(--color-brand)]"
    />
  )
}

export function addLeadsMessage(r: { added: number; skipped: number; imports: number }) {
  const parts = [`Added ${plural(r.added, 'lead')}`]
  if (r.skipped) parts.push(`skipped ${r.skipped.toLocaleString('en-US')}`)
  let msg = parts.join(', ')
  if (r.imports) msg += ` · ${plural(r.imports, 'search', 'searches')} queued`
  return msg
}

export function LeadsTab({ campaign }: { campaign: Campaign }) {
  const [status, setStatus] = useState<LeadStatus | ''>('')
  const [q, setQ] = useState('')
  const query = useDebounced(q.trim(), 300)
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [confirm, setConfirm] = useState(false)
  const [adding, setAdding] = useState(false)
  const active = campaign.status === 'active'

  const params = { status: status || undefined, q: query || undefined, offset, limit: PAGE }
  const leads = useLeads(campaign.id, params, { live: active })
  const addLeads = useAddLeads(campaign.id)
  const deleteLeads = useDeleteLeads(campaign.id)
  const numbers = useMemo(() => stepNumbers(campaign.sequence), [campaign.sequence])

  // New filter → first page, nothing selected.
  useEffect(() => {
    setOffset(0)
    setSelected(new Set())
  }, [status, query])

  const total = leads.data?.total ?? 0
  const rows = leads.data?.leads ?? []
  // After deleting the last leads of a page, step back to a page that exists.
  useEffect(() => {
    if (leads.data && offset > 0 && offset >= total) setOffset(Math.max(0, Math.floor((total - 1) / PAGE) * PAGE))
  }, [leads.data, offset, total])

  const pageIds = rows.map((l) => l.id)
  const selectedOnPage = pageIds.filter((id) => selected.has(id))
  const filtered = !!status || !!query

  const toggleOne = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s)
      if (on) n.add(id)
      else n.delete(id)
      return n
    })
  const togglePage = (on: boolean) =>
    setSelected((s) => {
      const n = new Set(s)
      for (const id of pageIds) {
        if (on) n.add(id)
        else n.delete(id)
      }
      return n
    })

  const onAdd = async (r: AddLeadsResult) => {
    const res = await addLeads.mutateAsync({ leads: r.leads, searchImports: r.searchImports })
    toast(addLeadsMessage(res), 'success')
    if (campaign.status === 'completed' && (res.added || res.imports)) toast('Start the campaign again to contact the new leads', 'info')
  }

  const currentStep = (l: Lead) => {
    if (!l.currentStepId) return '—'
    const s = campaign.sequence.steps[l.currentStepId]
    return s ? `${numbers.get(s.id) ?? '?'} · ${stepTitle(s)}` : 'Removed step'
  }

  const nextAction = (l: Lead) => {
    if (!l.nextActionAt) return { text: '—' }
    if (!active) return { text: campaign.status === 'completed' ? '—' : 'On hold', title: 'The campaign isn’t running' }
    return { text: timeUntil(l.nextActionAt), title: formatDateTime(l.nextActionAt) }
  }

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:max-w-xs">
          <Search size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, company, headline" aria-label="Search leads" className="pl-10" />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value as LeadStatus | '')} className="w-full sm:w-48" aria-label="Filter by status">
          <option value="">All statuses</option>
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>
          ))}
        </Select>
        <div className="flex flex-wrap gap-3 sm:ml-auto">
          {selected.size > 0 && (
            <Button variant="danger" onClick={() => setConfirm(true)} loading={deleteLeads.isPending}>
              <Trash2 size={16} /> Delete {selected.size.toLocaleString('en-US')}
            </Button>
          )}
          <Button variant="outline" onClick={() => setAdding(true)}>
            <Plus size={16} /> Add leads
          </Button>
        </div>
      </div>

      {leads.isPending ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading leads">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : leads.isError && !leads.data ? (
        <ErrorState title="Couldn’t load the leads" message={errorMessage(leads.error)} onRetry={() => void leads.refetch()} />
      ) : !rows.length ? (
        filtered ? (
          <EmptyState icon={<Search size={32} />} title="No leads match" action={<Button variant="outline" onClick={() => { setQ(''); setStatus('') }}>Clear filters</Button>} />
        ) : (
          <EmptyState
            icon={<Users size={36} />}
            title="No leads yet"
            body={campaign.pendingImports > 0 ? 'Leads from your LinkedIn search appear here as they are collected.' : 'Add people from a LinkedIn search, a list of profile URLs or a CSV file.'}
            action={<Button onClick={() => setAdding(true)}><Plus size={16} /> Add leads</Button>}
          />
        )
      ) : (
        <>
          <div className={cn('overflow-x-auto transition-opacity', leads.isPlaceholderData && 'opacity-60')}>
            <table className="w-full min-w-[920px] text-left text-sm">
              <thead className="text-ink-3">
                <tr className="border-b border-line">
                  <th className="w-10 py-3 pr-2">
                    <SelectBox
                      label="Select all leads on this page"
                      checked={selectedOnPage.length > 0 && selectedOnPage.length === pageIds.length}
                      indeterminate={selectedOnPage.length > 0 && selectedOnPage.length < pageIds.length}
                      onChange={togglePage}
                    />
                  </th>
                  <th className="py-3 pr-4 font-medium">Lead</th>
                  <th className="py-3 pr-4 font-medium">Status</th>
                  <th className="py-3 pr-4 font-medium">Current step</th>
                  <th className="py-3 pr-4 font-medium">Next action</th>
                  <th className="py-3 pr-4 font-medium">Last action</th>
                  <th className="py-3 font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => {
                  const name = `${l.firstName} ${l.lastName}`.trim() || 'LinkedIn member'
                  const next = nextAction(l)
                  return (
                    <tr key={l.id} className={cn('border-b border-line/60 last:border-0', selected.has(l.id) && 'bg-brand-soft/30')}>
                      <td className="py-3 pr-2">
                        <SelectBox label={`Select ${name}`} checked={selected.has(l.id)} onChange={(v) => toggleOne(l.id, v)} />
                      </td>
                      <td className="max-w-72 py-3 pr-4">
                        <div className="flex items-center gap-3">
                          <Avatar name={name} size={34} />
                          <div className="min-w-0">
                            <a href={l.profileUrl} target="_blank" rel="noreferrer" className="group inline-flex max-w-full items-center gap-1 font-medium hover:text-brand">
                              <span className="truncate">{name}</span>
                              <ExternalLink size={13} className="shrink-0 text-ink-3 group-hover:text-brand" aria-hidden />
                              <span className="sr-only">(opens LinkedIn)</span>
                            </a>
                            <p className="truncate text-xs text-ink-3" title={l.headline || undefined}>
                              {l.headline || l.company || l.listName || '—'}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 pr-4"><LeadStatusBadge status={l.status} /></td>
                      <td className="max-w-48 truncate py-3 pr-4 text-ink-2">{currentStep(l)}</td>
                      <td className={cn('whitespace-nowrap py-3 pr-4', next.text === 'due now' ? 'font-medium text-ok' : 'text-ink-2')} title={next.title}>
                        {next.text}
                      </td>
                      <td className="max-w-56 py-3 pr-4 text-ink-2">
                        {l.lastAction ? (
                          <>
                            <span className="block truncate">{l.lastAction}</span>
                            {l.lastActionAt && <span className="text-xs text-ink-3" title={formatDateTime(l.lastActionAt)}>{timeAgo(l.lastActionAt)}</span>}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="max-w-56 py-3 text-bad">
                        {l.error ? <span className="line-clamp-2 cursor-help" title={l.error}>{l.error}</span> : <span className="text-ink-3">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm text-ink-2">
            <span aria-live="polite">
              {(offset + 1).toLocaleString('en-US')}–{Math.min(offset + PAGE, total).toLocaleString('en-US')} of {plural(total, 'lead')}
              {selected.size > 0 && ` · ${selected.size.toLocaleString('en-US')} selected`}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} aria-label="Previous page">
                <ChevronLeft size={16} /> Prev
              </Button>
              <Button variant="outline" size="sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)} aria-label="Next page">
                Next <ChevronRight size={16} />
              </Button>
            </div>
          </div>
        </>
      )}

      <AddLeadsModal open={adding} onClose={() => setAdding(false)} onAdd={onAdd} />
      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Delete ${plural(selected.size, 'lead')}?`}
        body="They are removed from this campaign and no further actions are taken for them. Their activity history stays."
        onConfirm={() => {
          const ids = [...selected]
          deleteLeads.mutate(ids, {
            onSuccess: () => {
              setSelected(new Set())
              toast(`Deleted ${plural(ids.length, 'lead')}`, 'success')
            },
            onError: (e) => toast(errorMessage(e), 'error'),
          })
        }}
      />
    </div>
  )
}
