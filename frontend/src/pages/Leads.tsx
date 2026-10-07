import { useMemo, useState } from 'react'
import { ExternalLink, Search, Trash2, Download, Upload, Sparkles } from 'lucide-react'
import type { LeadStatus } from '../types'
import { useStore, toast } from '../store/useStore'
import { timeAgo } from '../lib/utils'
import { Avatar, Button, Card, ConfirmModal, EmptyState, Input, PageHeader, Select } from '../components/ui'
import { LeadStatusBadge, LEAD_STATUS_LABEL } from '../components/LeadStatusBadge'
import { AddLeadsModal } from '../components/campaign/AddLeadsModal'

const PAGE = 25

function toCsv(rows: string[][]) {
  return rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n')
}

export default function Leads() {
  const { leads, campaigns, deleteLeads, addLeads } = useStore()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<LeadStatus | ''>('')
  const [campaignId, setCampaignId] = useState('')
  const [list, setList] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(0)
  const [confirm, setConfirm] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  const campaignName = useMemo(() => Object.fromEntries(campaigns.map((c) => [c.id, c.name])), [campaigns])
  const lists = useMemo(() => [...new Set(leads.map((l) => l.listName))], [leads])

  const filtered = leads.filter((l) => {
    const text = `${l.firstName} ${l.lastName} ${l.company} ${l.headline}`.toLowerCase()
    return (
      text.includes(q.trim().toLowerCase()) &&
      (!status || l.status === status) &&
      (!list || l.listName === list) &&
      (!campaignId || (campaignId === 'none' ? !l.campaignId : l.campaignId === campaignId))
    )
  })
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE))
  const current = filtered.slice(page * PAGE, page * PAGE + PAGE)
  const allOnPage = current.length > 0 && current.every((l) => selected.has(l.id))

  const toggle = (id: string) => {
    const s = new Set(selected)
    if (s.has(id)) s.delete(id)
    else s.add(id)
    setSelected(s)
  }

  const exportCsv = () => {
    const rows = filtered.map((l) => [l.firstName, l.lastName, l.headline, l.company, l.location, l.profileUrl, l.email ?? '', LEAD_STATUS_LABEL[l.status], l.listName, l.campaignId ? campaignName[l.campaignId] ?? '' : ''])
    const blob = new Blob([toCsv([['first_name', 'last_name', 'headline', 'company', 'location', 'linkedin_url', 'email', 'status', 'list', 'campaign'], ...rows])], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'leads.csv'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <>
      <PageHeader
        title="Leads"
        actions={
          <div className="flex gap-3">
            <Button variant="outline" onClick={exportCsv} disabled={!filtered.length}><Download size={16} /> Export CSV</Button>
            <Button onClick={() => setImportOpen(true)}><Upload size={16} /> Import leads</Button>
          </div>
        }
      />
      <Card className="p-6 sm:p-8">
        <div className="mb-6 flex flex-wrap gap-3">
          <div className="relative w-full max-w-sm">
            <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
            <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(0) }} placeholder="Search name, company, title" className="pl-10" />
          </div>
          <Select value={status} onChange={(e) => { setStatus(e.target.value as LeadStatus | ''); setPage(0) }} className="w-44">
            <option value="">All statuses</option>
            {(Object.keys(LEAD_STATUS_LABEL) as LeadStatus[]).map((s) => <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>)}
          </Select>
          <Select value={campaignId} onChange={(e) => { setCampaignId(e.target.value); setPage(0) }} className="w-56">
            <option value="">All campaigns</option>
            <option value="none">Not in a campaign</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select value={list} onChange={(e) => { setList(e.target.value); setPage(0) }} className="w-56">
            <option value="">All lists</option>
            {lists.map((l) => <option key={l}>{l}</option>)}
          </Select>
          {selected.size > 0 && (
            <Button variant="ghost" className="ml-auto text-bad hover:text-bad" onClick={() => setConfirm(true)}>
              <Trash2 size={16} /> Delete {selected.size}
            </Button>
          )}
        </div>

        {filtered.length ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="text-ink-3">
                  <tr className="border-b border-line">
                    <th className="w-10 py-3">
                      <input
                        type="checkbox"
                        aria-label="Select page"
                        checked={allOnPage}
                        onChange={() => {
                          const s = new Set(selected)
                          current.forEach((l) => (allOnPage ? s.delete(l.id) : s.add(l.id)))
                          setSelected(s)
                        }}
                        className="size-4 cursor-pointer accent-[var(--color-brand)]"
                      />
                    </th>
                    <th className="py-3 pr-4 font-medium">Lead</th>
                    <th className="py-3 pr-4 font-medium">Location</th>
                    <th className="py-3 pr-4 font-medium">Campaign</th>
                    <th className="py-3 pr-4 font-medium">Status</th>
                    <th className="py-3 pr-4 font-medium">Last action</th>
                    <th className="py-3" />
                  </tr>
                </thead>
                <tbody>
                  {current.map((l) => (
                    <tr key={l.id} className="border-b border-line/60 last:border-0 hover:bg-panel-2/40">
                      <td className="py-3">
                        <input type="checkbox" aria-label={`Select ${l.firstName}`} checked={selected.has(l.id)} onChange={() => toggle(l.id)} className="size-4 cursor-pointer accent-[var(--color-brand)]" />
                      </td>
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-3">
                          <Avatar name={`${l.firstName} ${l.lastName}`} size={34} />
                          <div className="min-w-0">
                            <p className="font-medium">{l.firstName} {l.lastName}</p>
                            <p className="max-w-xs truncate text-xs text-ink-3">{l.headline || l.listName}</p>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 pr-4 text-ink-2">{l.location || '—'}</td>
                      <td className="py-3 pr-4 text-ink-2">{l.campaignId ? campaignName[l.campaignId] ?? '—' : '—'}</td>
                      <td className="py-3 pr-4"><LeadStatusBadge status={l.status} /></td>
                      <td className="py-3 pr-4 text-ink-2">{l.lastActionAt ? `${l.lastAction} · ${timeAgo(l.lastActionAt)}` : '—'}</td>
                      <td className="py-3 text-right">
                        <a href={l.profileUrl} target="_blank" rel="noreferrer" className="inline-block p-1 text-ink-3 hover:text-brand" aria-label="Open LinkedIn profile">
                          <ExternalLink size={16} />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-6 flex items-center justify-between text-sm text-ink-2">
              <span>
                {page * PAGE + 1}–{Math.min(filtered.length, (page + 1) * PAGE)} of {filtered.length}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
                <Button variant="outline" size="sm" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            </div>
          </>
        ) : (
          <EmptyState icon={<Sparkles size={36} />} title={leads.length ? 'No leads match your filters' : 'No leads yet'} body="Import leads from a LinkedIn search, profile URLs or a CSV file." />
        )}
      </Card>

      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Delete ${selected.size} lead${selected.size > 1 ? 's' : ''}?`}
        body="They’ll be removed from every campaign they’re in."
        onConfirm={() => {
          deleteLeads([...selected])
          toast(`${selected.size} leads deleted`, 'success')
          setSelected(new Set())
        }}
      />
      <AddLeadsModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onAdd={(r) => {
          const existing = new Set(leads.map((l) => l.id))
          const fresh = r.leads.filter((l) => !existing.has(l.id))
          addLeads(fresh)
          toast(`${fresh.length} leads imported to “${r.listName}”`, 'success')
        }}
      />
    </>
  )
}
