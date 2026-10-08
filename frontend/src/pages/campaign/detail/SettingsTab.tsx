import { useState } from 'react'
import { Save, Undo2 } from 'lucide-react'
import type { Campaign, CampaignSettings } from '@shared/types.ts'
import { ApiError, errorMessage } from '../../../api/client'
import { useUpdateCampaign } from '../../../api/hooks-campaigns'
import { toast } from '../../../lib/toast'
import { jsonEqual } from '../../../lib/utils'
import { Alert, Button } from '../../../components/ui'
import { CampaignSettingsForm } from '../../../components/campaign/CampaignSettingsForm'
import { settingsErrors } from '../../../components/campaign/settings'

export interface SettingsDraft {
  name: string
  settings: CampaignSettings
}

export const settingsDirty = (c: Campaign, d: SettingsDraft | null) => !!d && (d.name !== c.name || !jsonEqual(d.settings, c.settings))

export function SettingsTab({ campaign, draft, setDraft }: { campaign: Campaign; draft: SettingsDraft | null; setDraft: (d: SettingsDraft | null) => void }) {
  const update = useUpdateCampaign()
  const [serverError, setServerError] = useState<{ message: string; details: Record<string, string> } | null>(null)
  const shown = draft ?? { name: campaign.name, settings: campaign.settings }
  const dirty = settingsDirty(campaign, draft)
  const invalid = Object.keys(settingsErrors(shown.name, shown.settings)).length > 0

  const save = () => {
    setServerError(null)
    update.mutate(
      { id: campaign.id, patch: { name: shown.name.trim(), settings: shown.settings } },
      {
        onSuccess: () => {
          setDraft(null)
          toast('Settings saved', 'success')
        },
        onError: (e) => setServerError({ message: errorMessage(e), details: e instanceof ApiError ? (e.details ?? {}) : {} }),
      },
    )
  }

  return (
    <div>
      <CampaignSettingsForm
        name={shown.name}
        onNameChange={(name) => setDraft({ ...shown, name })}
        settings={shown.settings}
        onChange={(settings) => setDraft({ ...shown, settings })}
        errors={serverError?.details}
      />
      {serverError && <Alert tone="bad" className="mt-6">{serverError.message}</Alert>}
      <div className="mt-8 flex flex-wrap items-center justify-end gap-3 border-t border-line pt-6">
        <span className="mr-auto text-sm" aria-live="polite">
          {dirty ? <span className="font-medium text-warn">● Unsaved changes</span> : <span className="text-ink-3">Changes apply from the next action.</span>}
        </span>
        <Button
          variant="outline"
          disabled={!dirty || update.isPending}
          onClick={() => {
            setDraft(null)
            setServerError(null)
          }}
        >
          <Undo2 size={16} /> Discard
        </Button>
        <Button disabled={!dirty || invalid} loading={update.isPending} onClick={save}>
          <Save size={16} /> Save changes
        </Button>
      </div>
    </div>
  )
}
