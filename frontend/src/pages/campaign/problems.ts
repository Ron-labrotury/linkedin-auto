/** What stops a new campaign from being saved or launched. Pure (tested). */
import type { CampaignSettings, LeadInput, SearchImportInput, Sequence } from '@shared/types.ts'
import { countSteps, validateSequence } from '@shared/sequence.ts'
import { settingsErrors } from '../../components/campaign/settings'
import { MAX_LEADS_PER_REQUEST } from '../../components/campaign/leadImport'

export type NewCampaignTab = 'leads' | 'sequence' | 'settings'

export interface Problem {
  message: string
  tab: NewCampaignTab
  /** true: can't even be saved as a draft; false: only blocks the launch */
  blocksDraft: boolean
}

export const MAX_IMPORTS_PER_REQUEST = 50

export function campaignProblems(input: {
  name: string
  settings: CampaignSettings
  sequence: Sequence
  leads: LeadInput[]
  searchImports: SearchImportInput[]
}): Problem[] {
  const out: Problem[] = []
  for (const message of Object.values(settingsErrors(input.name, input.settings))) out.push({ message, tab: 'settings', blocksDraft: true })

  if (input.leads.length > MAX_LEADS_PER_REQUEST)
    out.push({
      message: `A new campaign can start with at most ${MAX_LEADS_PER_REQUEST.toLocaleString('en-US')} leads – add the rest from the campaign page later`,
      tab: 'leads',
      blocksDraft: true,
    })
  if (input.searchImports.length > MAX_IMPORTS_PER_REQUEST)
    out.push({ message: `Use at most ${MAX_IMPORTS_PER_REQUEST} LinkedIn searches`, tab: 'leads', blocksDraft: true })
  if (!input.leads.length && !input.searchImports.length) out.push({ message: 'Add at least one lead or LinkedIn search', tab: 'leads', blocksDraft: false })

  if (countSteps(input.sequence) === 0) out.push({ message: 'Add at least one step to the sequence', tab: 'sequence', blocksDraft: false })
  for (const issue of validateSequence(input.sequence)) out.push({ message: issue.message, tab: 'sequence', blocksDraft: true })
  return out
}
