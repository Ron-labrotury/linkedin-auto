import { useRef, useState } from 'react'
import { Lock, Pause, Save, Undo2 } from 'lucide-react'
import type { Campaign, Sequence } from '@shared/types.ts'
import { validateSequence } from '@shared/sequence.ts'
import { errorMessage } from '../../../api/client'
import { useUpdateCampaign } from '../../../api/hooks-campaigns'
import { toast } from '../../../lib/toast'
import { jsonEqual, plural } from '../../../lib/utils'
import { Alert, Button } from '../../../components/ui'
import { SequenceCanvas } from '../../../components/sequence/SequenceCanvas'

export const canEditSequence = (c: Pick<Campaign, 'status'>) => c.status !== 'active'

export function SequenceTab({
  campaign,
  draft,
  setDraft,
  onPause,
  pausing,
  stopOnReply,
}: {
  campaign: Campaign
  draft: Sequence | null
  setDraft: (s: Sequence | null) => void
  onPause: () => void
  pausing: boolean
  /** "Stop the sequence when a lead replies" (including an unsaved change on the Settings tab) */
  stopOnReply: boolean
}) {
  const update = useUpdateCampaign()
  // the latest draft, for save callbacks that finish after more edits were made
  const latestDraft = useRef(draft)
  latestDraft.current = draft
  const [error, setError] = useState<string | null>(null)
  // bumping the key gives the canvas a fresh undo history after save / discard
  const [version, setVersion] = useState(0)
  const editable = canEditSequence(campaign)
  const dirty = !!draft && !jsonEqual(draft, campaign.sequence)
  const shown = editable && draft ? draft : campaign.sequence
  const issues = validateSequence(shown)
  const total = campaign.stats.totalLeads

  const discard = () => {
    setDraft(null)
    setError(null)
    setVersion((v) => v + 1)
  }

  const save = () => {
    if (!draft) return
    const sent = draft
    setError(null)
    update.mutate(
      { id: campaign.id, patch: { sequence: sent } },
      {
        onSuccess: () => {
          // Edits made while the request was in flight stay as the (still unsaved) draft.
          if (jsonEqual(latestDraft.current, sent)) {
            setDraft(null)
            setVersion((v) => v + 1)
          }
          toast('Sequence saved', 'success')
        },
        onError: (e) => setError(errorMessage(e)),
      },
    )
  }

  const startSubtitle =
    [plural(total, 'lead'), campaign.pendingImports > 0 ? 'more from LinkedIn search' : ''].filter(Boolean).join(' + ')

  return (
    <div className="space-y-4">
      {campaign.status === 'active' && (
        <Alert
          tone="warn"
          icon={<Lock size={18} />}
          title="Pause the campaign to edit the sequence"
          action={
            <Button size="sm" variant="outline" onClick={onPause} loading={pausing}>
              <Pause size={14} /> Pause
            </Button>
          }
        >
          The sequence is locked while the campaign runs, so no lead ends up on a step that just changed.
        </Alert>
      )}
      {campaign.status === 'completed' && (
        <Alert tone="info" title="This campaign is completed">
          Every lead has finished. You can still change the sequence – it applies to leads you add from now on.
        </Alert>
      )}
      {!editable && dirty && (
        <Alert tone="warn" action={<Button size="sm" variant="outline" onClick={discard}>Discard</Button>}>
          You have unsaved sequence changes that can’t be saved while the campaign is {campaign.status}.
        </Alert>
      )}
      {editable && total > 0 && (
        <p className="text-sm text-ink-3">
          Changes apply to leads that haven’t reached the edited steps yet. Leads waiting on a step you delete start over at the first step if nothing was sent to
          them yet; otherwise they finish.
        </p>
      )}

      <SequenceCanvas
        key={version}
        sequence={shown}
        onChange={editable ? setDraft : undefined}
        readOnly={!editable}
        startSubtitle={startSubtitle}
        stopOnReply={stopOnReply}
      />

      {editable && (
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line pt-5">
          {error && <Alert tone="bad" className="w-full">{error}</Alert>}
          <span className="mr-auto text-sm" aria-live="polite">
            {dirty ? <span className="font-medium text-warn">● Unsaved changes</span> : <span className="text-ink-3">All changes saved</span>}
          </span>
          <Button variant="outline" disabled={!dirty || update.isPending} onClick={discard}>
            <Undo2 size={16} /> Discard
          </Button>
          <Button disabled={!dirty || issues.length > 0} loading={update.isPending} onClick={save} title={issues.length ? 'Fix the highlighted steps first' : undefined}>
            <Save size={16} /> Save sequence
          </Button>
        </div>
      )}
    </div>
  )
}
