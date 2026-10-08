import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Trash2, Plus, AlertTriangle, ExternalLink, Search, ArrowLeft, ArrowRight, Rocket, Save, FileSpreadsheet } from 'lucide-react'
import type { CampaignSettings, Sequence } from '@shared/types.ts'
import { countSteps, emptySequence } from '@shared/sequence.ts'
import { ApiError, errorMessage } from '../../api/client'
import { useCreateCampaign } from '../../api/hooks-campaigns'
import { toast } from '../../lib/toast'
import { cn, defaultCampaignName, jsonEqual, plural, uid } from '../../lib/utils'
import { Alert, Avatar, Button, Card, Tabs } from '../../components/ui'
import { AddLeadsModal, type AddLeadsResult } from '../../components/campaign/AddLeadsModal'
import { CampaignSettingsForm } from '../../components/campaign/CampaignSettingsForm'
import { DEFAULT_CAMPAIGN_SETTINGS } from '../../components/campaign/settings'
import { LinkedInNotice } from '../../components/campaign/LinkedInNotice'
import { dedupeLeads, leadName } from '../../components/campaign/leadImport'
import { SequenceCanvas } from '../../components/sequence/SequenceCanvas'
import { useUnsavedChangesGuard } from '../../components/layout/UnsavedChanges'
import { campaignProblems, type NewCampaignTab } from './problems'

type List = AddLeadsResult & { key: string }

const PREVIEW = 5

function LeadsIllustration() {
  return (
    <svg width="150" height="150" viewBox="0 0 170 170" aria-hidden>
      <rect x="40" y="18" width="100" height="125" rx="8" fill="var(--color-line-strong)" />
      <rect x="28" y="28" width="100" height="125" rx="8" fill="var(--color-panel-2)" stroke="var(--color-line-strong)" />
      {[55, 88, 121].map((y) => (
        <g key={y}>
          <circle cx="50" cy={y} r="11" fill="var(--color-line-strong)" />
          <rect x="68" y={y - 3} width="40" height="5" rx="2.5" fill="var(--color-line-strong)" />
        </g>
      ))}
      <circle cx="125" cy="138" r="22" fill="var(--color-ok)" />
      <path d="M125 127v22M114 138h22" stroke="#fff" strokeWidth="4" strokeLinecap="round" />
    </svg>
  )
}

function ListCard({ list, onRemove }: { list: List; onRemove: () => void }) {
  const isSearch = list.searchImports.length > 0
  return (
    <div className="rounded-xl border border-line">
      <div className="flex items-start justify-between gap-3 border-b border-line p-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-panel-2 text-brand" aria-hidden>
            {isSearch ? <Search size={18} /> : <FileSpreadsheet size={18} />}
          </span>
          <div className="min-w-0">
            <p className="truncate font-semibold">{list.listName}</p>
            <p className="text-sm text-ink-3">{isSearch ? 'LinkedIn search' : plural(list.leads.length, 'lead')}</p>
          </div>
        </div>
        <button type="button" onClick={onRemove} className="cursor-pointer rounded-md p-2 text-ink-2 hover:text-bad" aria-label={`Remove list ${list.listName}`} title="Remove list">
          <Trash2 size={18} />
        </button>
      </div>
      {isSearch ? (
        <ul className="divide-y divide-line">
          {list.searchImports.map((s) => (
            <li key={s.url} className="flex items-start gap-3 px-4 py-3 text-sm">
              <p className="min-w-0 flex-1">
                Will collect up to <span className="font-semibold">{plural(s.max, 'lead')}</span> from{' '}
                <a href={s.url} target="_blank" rel="noreferrer" className="break-all text-brand hover:underline">
                  {s.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 90)}
                  {s.url.length > 100 ? '…' : ''}
                </a>
                <span className="mt-1 block text-xs text-ink-3">Collected in the background by your LinkedIn account once the campaign runs.</span>
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="divide-y divide-line">
          {list.leads.slice(0, PREVIEW).map((lead) => (
            <li key={lead.profileUrl} className="flex items-center gap-3 px-4 py-3">
              <Avatar name={leadName(lead)} size={32} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{leadName(lead)}</p>
                {(lead.headline || lead.company) && <p className="truncate text-xs text-ink-3">{[lead.headline, lead.company].filter(Boolean).join(' · ')}</p>}
              </div>
              <a href={lead.profileUrl} target="_blank" rel="noreferrer" className="p-1 text-ink-3 hover:text-brand" aria-label={`Open ${leadName(lead)} on LinkedIn`}>
                <ExternalLink size={16} />
              </a>
            </li>
          ))}
          {list.leads.length > PREVIEW && <li className="px-4 py-3 text-sm text-ink-3">+ {plural(list.leads.length - PREVIEW, 'more lead')}</li>}
        </ul>
      )}
    </div>
  )
}

export default function NewCampaign() {
  const navigate = useNavigate()
  const create = useCreateCampaign()
  const [tab, setTab] = useState<NewCampaignTab>('leads')
  const [name, setName] = useState(() => defaultCampaignName())
  const [lists, setLists] = useState<List[]>([])
  const [sequence, setSequence] = useState<Sequence>(emptySequence)
  const [settings, setSettings] = useState<CampaignSettings>(DEFAULT_CAMPAIGN_SETTINGS)
  const [modal, setModal] = useState(false)
  const [serverError, setServerError] = useState<{ message: string; details: Record<string, string> } | null>(null)

  const leads = useMemo(() => dedupeLeads(lists), [lists])
  const searchImports = useMemo(() => lists.flatMap((l) => l.searchImports), [lists])
  const listedLeads = lists.reduce((n, l) => n + l.leads.length, 0)
  const searchMax = searchImports.reduce((n, s) => n + s.max, 0)
  const steps = countSteps(sequence)
  const problems = campaignProblems({ name, settings, sequence, leads, searchImports })
  const draftBlocked = problems.some((p) => p.blocksDraft)
  const dirty = lists.length > 0 || steps > 0 || !jsonEqual(settings, DEFAULT_CAMPAIGN_SETTINGS)

  // Ask before leaving (in-app links, back button, closing the tab) – nothing is saved until "Save" / "Launch".
  const guard = useUnsavedChangesGuard(dirty, {
    title: 'Leave this campaign unsaved?',
    body: 'Your leads, sequence and settings for this new campaign haven’t been saved. If you leave now, they are lost.',
  })

  const startSubtitle =
    [leads.length ? plural(leads.length, 'lead') : '', searchMax ? `up to ${searchMax.toLocaleString('en-US')} from search` : ''].filter(Boolean).join(' + ') || 'No leads yet'

  const save = (status: 'active' | 'draft') => {
    setServerError(null)
    create.mutate(
      { name: name.trim(), status, sequence, settings, leads, searchImports },
      {
        onSuccess: (c) => {
          guard.allowLeave()
          toast(status === 'active' ? 'Campaign launched' : 'Campaign saved as a draft', 'success')
          navigate(`/campaigns/${c.id}`)
        },
        onError: (e) => {
          setServerError({ message: errorMessage(e), details: e instanceof ApiError ? (e.details ?? {}) : {} })
          if (e instanceof ApiError && e.details?.sequence) setTab('sequence')
        },
      },
    )
  }

  const tabs: { id: NewCampaignTab; label: string }[] = [
    { id: 'leads', label: `Add Leads${lists.length ? ` (${searchImports.length ? (leads.length ? `${leads.length}+` : 'search') : leads.length})` : ''}` },
    { id: 'sequence', label: `Create a Sequence${steps ? ` (${steps})` : ''}` },
    { id: 'settings', label: 'Settings' },
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/campaigns" className="rounded-lg p-2 text-ink-2 hover:bg-panel hover:text-ink" aria-label="Back to campaigns">
          <ArrowLeft size={22} />
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">New campaign</h1>
      </div>

      <Card className="overflow-hidden">
        <Tabs<NewCampaignTab> value={tab} onChange={setTab} tabs={tabs} />

        <div className="p-5 sm:p-10">
          {tab === 'leads' && (
            <>
              <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-semibold">Lists of leads</h2>
                  {lists.length > 0 && (
                    <p className="mt-1 text-sm text-ink-3">
                      {plural(leads.length, 'unique lead')}
                      {listedLeads > leads.length && ` (${plural(listedLeads - leads.length, 'duplicate')} removed)`}
                      {searchImports.length > 0 && ` · ${plural(searchImports.length, 'search', 'searches')}`}
                    </p>
                  )}
                </div>
                {lists.length > 0 && (
                  <div className="flex flex-wrap gap-3">
                    <Button variant="outline" onClick={() => setModal(true)}><Plus size={16} /> Add more leads</Button>
                    <Button onClick={() => setTab('sequence')}>Next: sequence <ArrowRight size={16} /></Button>
                  </div>
                )}
              </div>

              {lists.length === 0 ? (
                <div className="flex flex-col items-center py-12 text-center">
                  <LeadsIllustration />
                  <p className="mt-6 text-xl">Add the people this campaign should reach</p>
                  <p className="mt-2 max-w-md text-sm text-ink-2">Paste a LinkedIn search, a list of profile URLs, or upload a CSV file.</p>
                  <Button size="lg" className="mt-8" onClick={() => setModal(true)}><Plus size={18} /> Add leads</Button>
                  <button type="button" className="mt-4 cursor-pointer text-sm text-ink-3 hover:text-ink" onClick={() => setTab('sequence')}>
                    Skip for now and build the sequence
                  </button>
                </div>
              ) : (
                <div className="grid gap-4 lg:grid-cols-2">
                  {lists.map((l) => (
                    <ListCard key={l.key} list={l} onRemove={() => setLists((ls) => ls.filter((x) => x.key !== l.key))} />
                  ))}
                </div>
              )}
            </>
          )}

          {tab === 'sequence' && (
            <>
              <div className="mb-4">
                <h2 className="text-2xl font-semibold">Your sequence</h2>
                <p className="mt-1 text-sm text-ink-2">Each lead goes through these steps from top to bottom. Click a step to edit it, or a + to add one.</p>
              </div>
              <SequenceCanvas sequence={sequence} onChange={setSequence} startSubtitle={startSubtitle} stopOnReply={settings.stopOnReply} />
              <div className="mt-6 flex flex-wrap justify-end gap-3">
                <Button variant="outline" onClick={() => setTab('leads')}><ArrowLeft size={16} /> Back</Button>
                <Button onClick={() => setTab('settings')}>Next: settings <ArrowRight size={16} /></Button>
              </div>
            </>
          )}

          {tab === 'settings' && (
            <>
              <CampaignSettingsForm name={name} onNameChange={setName} settings={settings} onChange={setSettings} errors={serverError?.details} />

              <div className="mt-6 space-y-4">
                <LinkedInNotice />
                {problems.length > 0 && (
                  <div className="rounded-xl border border-warn/40 bg-warn/10 p-4" role="status">
                    <p className="mb-2 flex items-center gap-2 font-semibold text-warn"><AlertTriangle size={18} aria-hidden /> Before you launch</p>
                    <ul className="space-y-1.5 text-sm text-ink-2">
                      {problems.map((p, i) => (
                        <li key={`${p.message}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
                          <span aria-hidden>•</span>
                          <span className={cn(p.blocksDraft && 'text-ink')}>{p.message}</span>
                          {p.tab !== 'settings' && (
                            <button type="button" className="cursor-pointer text-xs font-medium text-brand hover:underline" onClick={() => setTab(p.tab)}>
                              {p.tab === 'leads' ? 'Go to leads' : 'Go to sequence'}
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {serverError && <Alert tone="bad" title="Couldn’t save the campaign">{serverError.message}</Alert>}
              </div>

              <div className="mt-8 flex flex-wrap justify-end gap-3 border-t border-line pt-6">
                <Button variant="outline" size="lg" onClick={() => setTab('sequence')} disabled={create.isPending}><ArrowLeft size={16} /> Back</Button>
                <Button
                  variant="outline"
                  size="lg"
                  disabled={draftBlocked || create.isPending}
                  loading={create.isPending && create.variables?.status === 'draft'}
                  onClick={() => save('draft')}
                  title={draftBlocked ? 'Fix the problems above first' : undefined}
                >
                  <Save size={16} /> Save as draft
                </Button>
                <Button
                  size="lg"
                  disabled={problems.length > 0 || create.isPending}
                  loading={create.isPending && create.variables?.status === 'active'}
                  onClick={() => save('active')}
                >
                  <Rocket size={16} /> Launch campaign
                </Button>
              </div>
            </>
          )}
        </div>
      </Card>

      <AddLeadsModal open={modal} onClose={() => setModal(false)} onAdd={(r) => setLists((ls) => [...ls, { ...r, key: uid('list') }])} />
      {guard.dialog}
    </div>
  )
}
