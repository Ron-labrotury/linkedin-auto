import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Trash2, Plus, AlertTriangle, ExternalLink } from 'lucide-react'
import type { CampaignSettings, Sequence } from '../../types'
import { useStore, toast } from '../../store/useStore'
import { DEFAULT_SETTINGS } from '../../data/mock'
import { emptySequence, validateSequence, countSteps } from '../../lib/sequence'
import { defaultCampaignName } from '../../lib/utils'
import { Avatar, Button, Card, Tabs } from '../../components/ui'
import { AddLeadsModal, type AddLeadsResult } from '../../components/campaign/AddLeadsModal'
import { CampaignSettingsForm } from '../../components/campaign/CampaignSettingsForm'
import { SequenceCanvas } from '../../components/sequence/SequenceCanvas'

type Tab = 'leads' | 'sequence' | 'settings'

function LeadsIllustration() {
  return (
    <svg width="170" height="170" viewBox="0 0 170 170" aria-hidden>
      <rect x="40" y="18" width="100" height="125" rx="8" fill="#cfd6e6" />
      <rect x="28" y="28" width="100" height="125" rx="8" fill="#eef1f8" />
      {[55, 88, 121].map((y) => (
        <g key={y}>
          <circle cx="50" cy={y} r="11" fill="#cfd6e6" />
          <rect x="68" y={y - 3} width="40" height="5" rx="2.5" fill="#cfd6e6" />
        </g>
      ))}
      <circle cx="125" cy="138" r="22" fill="#4ade80" />
      <path d="M125 127v22M114 138h22" stroke="#fff" strokeWidth="4" strokeLinecap="round" />
    </svg>
  )
}

export default function NewCampaign() {
  const navigate = useNavigate()
  const createCampaign = useStore((s) => s.createCampaign)
  const [tab, setTab] = useState<Tab>('leads')
  const [name, setName] = useState(defaultCampaignName)
  const [lists, setLists] = useState<AddLeadsResult[]>([])
  const [sequence, setSequence] = useState<Sequence>(emptySequence)
  const [settings, setSettings] = useState<CampaignSettings>(DEFAULT_SETTINGS)
  const [modal, setModal] = useState(false)

  const leads = useMemo(() => {
    const seen = new Set<string>()
    return lists.flatMap((l) => l.leads).filter((l) => {
      const key = l.profileUrl.toLowerCase().replace(/\/?$/, '/')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [lists])

  const problems = [
    !name.trim() && 'Give the campaign a name',
    !leads.length && 'Add at least one lead',
    !sequence.rootId && 'Add at least one step to the sequence',
    ...validateSequence(sequence).map((i) => i.message),
    !settings.workingDays.length && 'Pick at least one working day',
  ].filter(Boolean) as string[]

  const save = (status: 'active' | 'draft') => {
    const id = createCampaign({ name: name.trim() || defaultCampaignName(), status, sequence, settings }, leads)
    toast(status === 'active' ? 'Campaign launched' : 'Campaign saved as a draft', 'success')
    navigate(`/campaigns/${id}`)
  }

  return (
    <Card className="overflow-hidden">
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'leads', label: `Add Leads${leads.length ? ` (${leads.length})` : ''}` },
          { id: 'sequence', label: `Create a Sequence${countSteps(sequence) ? ` (${countSteps(sequence)})` : ''}` },
          { id: 'settings', label: 'Settings' },
        ]}
      />

      <div className="p-6 sm:p-10">
        {tab === 'leads' && (
          <>
            <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
              <h2 className="text-2xl font-semibold">Lists of leads</h2>
              {lists.length > 0 && (
                <div className="flex gap-3">
                  <Button variant="outline" onClick={() => setModal(true)}><Plus size={16} /> Add more leads</Button>
                  <Button onClick={() => setTab('sequence')}>Next: sequence</Button>
                </div>
              )}
            </div>

            {lists.length === 0 ? (
              <div className="flex flex-col items-center py-16 text-center">
                <LeadsIllustration />
                <p className="mt-6 text-xl">Add leads from LinkedIn to this campaign</p>
                <Button size="lg" className="mt-8 w-44" onClick={() => setModal(true)}>Add leads</Button>
              </div>
            ) : (
              <div className="space-y-6">
                {lists.map((l, i) => (
                  <div key={i} className="rounded-xl border border-line">
                    <div className="flex items-center justify-between gap-3 border-b border-line p-4">
                      <div>
                        <p className="font-semibold">{l.listName}</p>
                        <p className="text-sm text-ink-3">{l.leads.length} leads</p>
                      </div>
                      <button onClick={() => setLists(lists.filter((_, j) => j !== i))} className="cursor-pointer p-2 text-ink-2 hover:text-bad" aria-label="Remove list">
                        <Trash2 size={18} />
                      </button>
                    </div>
                    <ul className="max-h-80 divide-y divide-line overflow-y-auto">
                      {l.leads.slice(0, 50).map((lead) => (
                        <li key={lead.id} className="flex items-center gap-3 px-4 py-3">
                          <Avatar name={`${lead.firstName} ${lead.lastName}`} size={32} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{lead.firstName} {lead.lastName}</p>
                            {lead.headline && <p className="truncate text-xs text-ink-3">{lead.headline}</p>}
                          </div>
                          <a href={lead.profileUrl} target="_blank" rel="noreferrer" className="text-ink-3 hover:text-brand" aria-label="Open profile">
                            <ExternalLink size={16} />
                          </a>
                        </li>
                      ))}
                      {l.leads.length > 50 && <li className="px-4 py-3 text-sm text-ink-3">+ {l.leads.length - 50} more</li>}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'sequence' && (
          <>
            <SequenceCanvas sequence={sequence} onChange={setSequence} leadCount={leads.length} listName={lists.map((l) => l.listName).join(', ')} />
            <div className="mt-6 flex justify-end gap-3">
              <Button variant="outline" onClick={() => setTab('leads')}>Back</Button>
              <Button onClick={() => setTab('settings')}>Next: settings</Button>
            </div>
          </>
        )}

        {tab === 'settings' && (
          <>
            <CampaignSettingsForm name={name} onNameChange={setName} settings={settings} onChange={setSettings} />
            {problems.length > 0 && (
              <div className="mt-6 rounded-xl border border-warn/40 bg-warn/10 p-4">
                <p className="mb-2 flex items-center gap-2 font-semibold text-warn"><AlertTriangle size={18} /> Before you launch</p>
                <ul className="list-inside list-disc space-y-1 text-sm text-ink-2">
                  {problems.map((p) => <li key={p}>{p}</li>)}
                </ul>
              </div>
            )}
            <div className="mt-8 flex flex-wrap justify-end gap-3 border-t border-line pt-6">
              <Button variant="outline" size="lg" onClick={() => setTab('sequence')}>Back</Button>
              <Button variant="outline" size="lg" onClick={() => save('draft')}>Save as draft</Button>
              <Button size="lg" disabled={problems.length > 0} onClick={() => save('active')}>Launch campaign</Button>
            </div>
          </>
        )}
      </div>

      <AddLeadsModal open={modal} onClose={() => setModal(false)} onAdd={(r) => setLists((ls) => [...ls, r])} />
    </Card>
  )
}
