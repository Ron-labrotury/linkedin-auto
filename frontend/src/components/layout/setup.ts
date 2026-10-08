import type { CampaignSummary, LinkedInAccount } from '@shared/types.ts'

export interface SetupStep {
  id: 'linkedin' | 'create' | 'launch'
  label: string
  done: boolean
  to: string
}

/** The "Finish set-up" checklist, computed from real data. */
export function setupSteps(account: LinkedInAccount | undefined, campaigns: CampaignSummary[] | undefined): SetupStep[] {
  const list = campaigns ?? []
  return [
    { id: 'linkedin', label: 'Connect LinkedIn', done: account?.status === 'connected', to: '/connect' },
    { id: 'create', label: 'Create a campaign', done: list.length > 0, to: '/campaigns/new' },
    // a paused or completed campaign was launched at some point
    { id: 'launch', label: 'Launch a campaign', done: list.some((c) => c.status !== 'draft'), to: list.length ? '/campaigns' : '/campaigns/new' },
  ]
}
