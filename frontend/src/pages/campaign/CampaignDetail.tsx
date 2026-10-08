import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Pencil, SearchX, Trash2 } from 'lucide-react'
import type { Campaign, CampaignStatus, Sequence } from '@shared/types.ts'
import { ApiError, errorMessage } from '../../api/client'
import { useCampaign, useDeleteCampaign, useUpdateCampaign } from '../../api/hooks-campaigns'
import { toast } from '../../lib/toast'
import { cn, formatDate, jsonEqual } from '../../lib/utils'
import { Badge, Button, Card, ConfirmModal, EmptyState, ErrorState, Skeleton, Tabs, Toggle } from '../../components/ui'
import { CAMPAIGN_STATUS, useToggleCampaign } from '../../components/CampaignTable'
import { LinkedInNotice } from '../../components/campaign/LinkedInNotice'
import { useUnsavedChangesGuard } from '../../components/layout/UnsavedChanges'
import { NAME_MAX } from '../../components/campaign/settings'
import { ImportProgress, StatsFunnel } from './detail/Overview'
import { LeadsTab } from './detail/LeadsTab'
import { ActivityTab } from './detail/ActivityTab'
import { SequenceTab } from './detail/SequenceTab'
import { SettingsTab, settingsDirty, type SettingsDraft } from './detail/SettingsTab'

type Tab = 'leads' | 'activity' | 'sequence' | 'settings'

const STATUS_NOTE: Record<CampaignStatus, string> = {
  draft: 'Draft – nothing is sent until you start it.',
  active: 'Running – steps run inside your active hours, with a random pause between actions.',
  paused: 'Paused – no actions are taken until you start it again.',
  completed: 'Completed – every lead has finished. Add new leads and start it again to continue.',
}

function InlineName({ campaign, onRenamed }: { campaign: Campaign; onRenamed: (name: string) => void }) {
  const update = useUpdateCampaign()
  const [editing, setEditing] = useState(false)

  const commit = (raw: string) => {
    setEditing(false)
    const name = raw.trim()
    if (!name || name === campaign.name) return
    if (name.length > NAME_MAX) return toast(`Use at most ${NAME_MAX} characters`, 'error')
    update.mutate(
      { id: campaign.id, patch: { name } },
      { onSuccess: () => onRenamed(name), onError: (e) => toast(errorMessage(e), 'error') },
    )
  }

  if (editing)
    return (
      <input
        autoFocus
        defaultValue={campaign.name}
        maxLength={NAME_MAX}
        aria-label="Campaign name"
        className="h-12 w-full min-w-0 max-w-xl rounded-lg border border-brand bg-bg/60 px-3 text-xl font-semibold text-ink focus:outline-none focus:ring-2 focus:ring-brand/25 sm:text-2xl"
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            e.currentTarget.value = campaign.name
            e.currentTarget.blur()
          }
        }}
      />
    )
  return (
    <h1 className="min-w-0 text-2xl font-semibold tracking-tight sm:text-3xl">
      <button type="button" onClick={() => setEditing(true)} title="Rename campaign" className="group inline-flex min-w-0 cursor-pointer items-center gap-2 text-left">
        <span className="min-w-0 break-words">{campaign.name}</span>
        <Pencil size={18} className="shrink-0 text-ink-3 opacity-60 group-hover:opacity-100" aria-hidden />
        <span className="sr-only">(rename)</span>
      </button>
    </h1>
  )
}

function DetailSkeleton() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading campaign">
      <Skeleton className="h-10 w-72" />
      <Skeleton className="h-28" />
      <Skeleton className="h-96" />
    </div>
  )
}

function CampaignPage({ id }: { id: string }) {
  const navigate = useNavigate()
  const query = useCampaign(id)
  const remove = useDeleteCampaign()
  const { toggle, isPending: togglePending } = useToggleCampaign()
  const [tab, setTab] = useState<Tab>('leads')
  const [seqDraft, setSeqDraft] = useState<Sequence | null>(null)
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft | null>(null)
  const [confirm, setConfirm] = useState(false)
  const campaign = query.data

  // A 404 wins over cached data: the campaign was deleted (here or in another tab).
  const notFound = query.error instanceof ApiError && query.error.status === 404

  const seqDirty = !!campaign && !!seqDraft && !jsonEqual(seqDraft, campaign.sequence)
  const setDirty = !!campaign && settingsDirty(campaign, settingsDraft)

  // Ask before leaving the page (in-app links, back button, closing the tab) with unsaved edits.
  const guard = useUnsavedChangesGuard(!notFound && (seqDirty || setDirty), {
    body: `Your ${seqDirty && setDirty ? 'sequence and settings changes haven’t' : seqDirty ? 'sequence changes haven’t' : 'settings changes haven’t'} been saved. If you leave now, they are lost.`,
  })

  if (query.isPending) return <DetailSkeleton />
  if (notFound)
    return (
      <EmptyState
        icon={<SearchX size={36} />}
        title="Campaign not found"
        body="It may have been deleted, or it belongs to another account."
        action={<Button onClick={() => navigate('/campaigns')}>Back to campaigns</Button>}
      />
    )
  if (!campaign)
    return <ErrorState title="Couldn’t load this campaign" message={errorMessage(query.error)} onRetry={() => void query.refetch()} />

  const isActive = campaign.status === 'active'
  const status = CAMPAIGN_STATUS[campaign.status]
  const pending = togglePending(campaign.id)

  const onToggle = () => {
    if (!isActive && seqDirty) {
      setTab('sequence')
      return toast('Save or discard your sequence changes before starting the campaign', 'error')
    }
    void toggle(campaign)
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'leads', label: `Leads (${campaign.stats.totalLeads.toLocaleString('en-US')})` },
    { id: 'activity', label: 'Activity' },
    { id: 'sequence', label: `Sequence${seqDirty ? ' •' : ''}` },
    { id: 'settings', label: `Settings${setDirty ? ' •' : ''}` },
  ]

  return (
    <div className="space-y-6 sm:space-y-8">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <Link to="/campaigns" className="rounded-lg p-2 text-ink-2 hover:bg-panel hover:text-ink" aria-label="Back to campaigns">
            <ArrowLeft size={22} />
          </Link>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
            <InlineName campaign={campaign} onRenamed={(name) => setSettingsDraft((d) => (d ? { ...d, name } : d))} />
            <Badge tone={status.tone}>{status.label}</Badge>
          </div>
          <div className="flex items-center gap-4">
            <span className="hidden text-sm text-ink-3 md:inline">Created {formatDate(campaign.createdAt)}</span>
            <span className="flex items-center gap-2 text-sm text-ink-2">
              <span className={cn('inline-flex', pending && 'pointer-events-none opacity-60')} aria-busy={pending || undefined}>
                <Toggle checked={isActive} label={isActive ? 'Pause campaign' : 'Start campaign'} onChange={onToggle} />
              </span>
              {isActive ? 'Running' : 'Start'}
            </span>
            <button
              type="button"
              onClick={() => setConfirm(true)}
              className="cursor-pointer rounded-md p-1 text-ink-2 hover:text-bad"
              aria-label="Delete campaign"
              title="Delete campaign"
            >
              <Trash2 size={20} />
            </button>
          </div>
        </div>
        <p className="text-sm text-ink-3 sm:pl-12">{STATUS_NOTE[campaign.status]}</p>
      </header>

      {isActive && <LinkedInNotice />}

      <StatsFunnel c={campaign} />
      <ImportProgress c={campaign} />

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <div className="min-w-[520px]">
            <Tabs<Tab> value={tab} onChange={setTab} tabs={tabs} />
          </div>
        </div>
        <div className="p-4 sm:p-8">
          {tab === 'leads' && <LeadsTab campaign={campaign} />}
          {tab === 'activity' && <ActivityTab campaign={campaign} />}
          {tab === 'sequence' && (
            <SequenceTab
              campaign={campaign}
              draft={seqDraft}
              setDraft={setSeqDraft}
              onPause={() => void toggle(campaign)}
              pausing={pending}
              stopOnReply={(settingsDraft?.settings ?? campaign.settings).stopOnReply}
            />
          )}
          {tab === 'settings' && <SettingsTab campaign={campaign} draft={settingsDraft} setDraft={setSettingsDraft} />}
        </div>
      </Card>

      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete campaign?"
        body={<>“{campaign.name}” stops immediately and its {campaign.stats.totalLeads.toLocaleString('en-US')} leads are deleted. This can’t be undone.</>}
        onConfirm={() =>
          remove.mutate(campaign.id, {
            onSuccess: () => {
              toast('Campaign deleted', 'success')
              guard.allowLeave()
              navigate('/campaigns')
            },
            onError: (e) => toast(errorMessage(e), 'error'),
          })
        }
      />
      {guard.dialog}
    </div>
  )
}

export default function CampaignDetail() {
  const { id = '' } = useParams()
  return <CampaignPage key={id} id={id} />
}
