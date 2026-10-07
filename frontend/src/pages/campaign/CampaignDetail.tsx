import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, ExternalLink, Pencil, Search, Trash2 } from 'lucide-react'
import type { Campaign, LeadStatus } from '../../types'
import { useStore, toast } from '../../store/useStore'
import { validateSequence } from '../../lib/sequence'
import { cn, formatDate, pct, timeAgo } from '../../lib/utils'
import { Avatar, Badge, Button, Card, ConfirmModal, EmptyState, Input, Select, Tabs, Toggle } from '../../components/ui'
import { SequenceCanvas } from '../../components/sequence/SequenceCanvas'
import { CampaignSettingsForm } from '../../components/campaign/CampaignSettingsForm'
import { LeadStatusBadge, LEAD_STATUS_LABEL } from '../../components/LeadStatusBadge'

type Tab = 'leads' | 'sequence' | 'settings'

function Funnel({ c }: { c: Campaign }) {
  const s = c.stats
  const items = [
    { label: 'Profile views', value: s.profileViews },
    { label: 'Invites sent', value: s.invitesSent },
    { label: 'Accepted', value: s.accepted, rate: pct(s.accepted, s.invitesSent) },
    { label: 'Messages sent', value: s.messagesSent },
    { label: 'Replied', value: s.replied, rate: pct(s.replied, s.messagesSent) },
    { label: 'Emails sent', value: s.emailsSent },
  ]
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3 xl:grid-cols-6">
      {items.map((i) => (
        <div key={i.label} className="bg-panel p-5">
          <p className="text-sm text-ink-2">{i.label}</p>
          <p className="mt-2 text-3xl font-medium tabular-nums">{i.value}</p>
          {i.rate !== undefined && <p className="mt-1 text-xs text-ink-3">{i.rate}% rate</p>}
        </div>
      ))}
    </div>
  )
}

export default function CampaignDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const campaign = useStore((s) => s.campaigns.find((c) => c.id === id))
  const allLeads = useStore((s) => s.leads)
  const { updateCampaign, toggleCampaign, deleteCampaign } = useStore()
  const [tab, setTab] = useState<Tab>('leads')
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<LeadStatus | ''>('')
  const [confirm, setConfirm] = useState(false)
  const [draft, setDraft] = useState(campaign ? { name: campaign.name, settings: campaign.settings } : null)
  const [editingName, setEditingName] = useState(false)

  useEffect(() => {
    if (campaign) setDraft({ name: campaign.name, settings: campaign.settings })
    // only reset the draft when switching campaigns
  }, [campaign?.id])

  const leads = useMemo(() => {
    if (!campaign) return []
    const ids = new Set(campaign.leadIds)
    return allLeads.filter((l) => ids.has(l.id))
  }, [allLeads, campaign])

  if (!campaign || !draft) {
    return (
      <EmptyState
        icon={<Search size={36} />}
        title="Campaign not found"
        body="It may have been deleted."
        action={<Button onClick={() => navigate('/campaigns')}>Back to campaigns</Button>}
      />
    )
  }

  const filtered = leads.filter(
    (l) =>
      (!status || l.status === status) &&
      `${l.firstName} ${l.lastName} ${l.company}`.toLowerCase().includes(q.trim().toLowerCase()),
  )
  const isActive = campaign.status === 'active'
  const settingsDirty = draft.name !== campaign.name || JSON.stringify(draft.settings) !== JSON.stringify(campaign.settings)

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-4">
        <Link to="/campaigns" className="rounded-lg p-2 text-ink-2 hover:bg-panel hover:text-ink" aria-label="Back to campaigns">
          <ArrowLeft size={22} />
        </Link>
        {editingName ? (
          <Input
            autoFocus
            defaultValue={campaign.name}
            className="h-12 max-w-md text-2xl font-semibold"
            onBlur={(e) => {
              const v = e.target.value.trim()
              if (v) updateCampaign(campaign.id, { name: v })
              setDraft((d) => d && { ...d, name: v || campaign.name })
              setEditingName(false)
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <button onClick={() => setEditingName(true)} className="group flex cursor-pointer items-center gap-2 text-3xl font-semibold tracking-tight">
            {campaign.name}
            <Pencil size={18} className="text-ink-3 opacity-0 group-hover:opacity-100" />
          </button>
        )}
        <Badge tone={isActive ? 'ok' : campaign.status === 'draft' ? 'neutral' : 'warn'}>
          {campaign.status[0].toUpperCase() + campaign.status.slice(1)}
        </Badge>
        <div className="ml-auto flex items-center gap-4">
          <span className="text-sm text-ink-3">Created {formatDate(campaign.createdAt)}</span>
          <Toggle
            checked={isActive}
            label="Campaign running"
            onChange={() => {
              if (!isActive) {
                if (!campaign.sequence.rootId) return toast('Add at least one step to the sequence first', 'error')
                if (!campaign.leadIds.length) return toast('Add leads before starting the campaign', 'error')
                if (validateSequence(campaign.sequence).length) return toast('Fix the highlighted sequence steps first', 'error')
              }
              toggleCampaign(campaign.id)
              toast(isActive ? 'Campaign paused' : 'Campaign started', 'success')
            }}
          />
          <button onClick={() => setConfirm(true)} className="cursor-pointer text-ink-2 hover:text-bad" aria-label="Delete campaign">
            <Trash2 size={20} />
          </button>
        </div>
      </div>

      <Funnel c={campaign} />

      <Card className="overflow-hidden">
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'leads', label: `Leads (${leads.length})` },
            { id: 'sequence', label: 'Sequence' },
            { id: 'settings', label: 'Settings' },
          ]}
        />
        <div className="p-6 sm:p-8">
          {tab === 'leads' && (
            <>
              <div className="mb-6 flex flex-wrap gap-3">
                <div className="relative w-full max-w-sm">
                  <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search leads" className="pl-10" />
                </div>
                <Select value={status} onChange={(e) => setStatus(e.target.value as LeadStatus | '')} className="w-48">
                  <option value="">All statuses</option>
                  {(Object.keys(LEAD_STATUS_LABEL) as LeadStatus[]).map((s) => <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>)}
                </Select>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="text-ink-3">
                    <tr className="border-b border-line">
                      <th className="py-3 pr-4 font-medium">Lead</th>
                      <th className="py-3 pr-4 font-medium">Company</th>
                      <th className="py-3 pr-4 font-medium">Status</th>
                      <th className="py-3 pr-4 font-medium">Last action</th>
                      <th className="py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((l) => (
                      <tr key={l.id} className="border-b border-line/60 last:border-0">
                        <td className="py-3 pr-4">
                          <div className="flex items-center gap-3">
                            <Avatar name={`${l.firstName} ${l.lastName}`} size={34} />
                            <div className="min-w-0">
                              <p className="font-medium">{l.firstName} {l.lastName}</p>
                              <p className="max-w-xs truncate text-xs text-ink-3">{l.headline}</p>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 pr-4 text-ink-2">{l.company || '—'}</td>
                        <td className="py-3 pr-4"><LeadStatusBadge status={l.status} /></td>
                        <td className="py-3 pr-4 text-ink-2">{l.lastAction ? `${l.lastAction} · ${timeAgo(l.lastActionAt!)}` : '—'}</td>
                        <td className="py-3 text-right">
                          <a href={l.profileUrl} target="_blank" rel="noreferrer" className="inline-block p-1 text-ink-3 hover:text-brand" aria-label="Open LinkedIn profile">
                            <ExternalLink size={16} />
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!filtered.length && <p className="py-10 text-center text-ink-3">No leads match.</p>}
              </div>
            </>
          )}

          {tab === 'sequence' && (
            <>
              {isActive && (
                <p className="mb-4 rounded-lg border border-warn/30 bg-warn/10 p-3 text-sm text-warn">
                  This campaign is running. Changes apply to leads that haven’t reached the edited step yet.
                </p>
              )}
              <SequenceCanvas
                sequence={campaign.sequence}
                onChange={(sequence) => updateCampaign(campaign.id, { sequence })}
                leadCount={leads.length}
                listName={leads[0]?.listName}
              />
            </>
          )}

          {tab === 'settings' && (
            <>
              <CampaignSettingsForm
                name={draft.name}
                onNameChange={(name) => setDraft({ ...draft, name })}
                settings={draft.settings}
                onChange={(settings) => setDraft({ ...draft, settings })}
              />
              <div className={cn('mt-8 flex justify-end gap-3 border-t border-line pt-6')}>
                <Button variant="outline" disabled={!settingsDirty} onClick={() => setDraft({ name: campaign.name, settings: campaign.settings })}>Discard</Button>
                <Button
                  disabled={!settingsDirty || !draft.name.trim() || !draft.settings.workingDays.length}
                  onClick={() => {
                    updateCampaign(campaign.id, { name: draft.name.trim(), settings: draft.settings })
                    toast('Settings saved', 'success')
                  }}
                >
                  Save changes
                </Button>
              </div>
            </>
          )}
        </div>
      </Card>

      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete campaign?"
        body={<>“{campaign.name}” will stop immediately and its leads will be unassigned.</>}
        onConfirm={() => {
          deleteCampaign(campaign.id)
          toast('Your campaign has been successfully removed')
          navigate('/campaigns')
        }}
      />
    </div>
  )
}
