export type CampaignStatus = 'active' | 'paused' | 'draft' | 'completed'

export type LeadStatus =
  | 'queued'
  | 'in_progress'
  | 'invited'
  | 'connected'
  | 'replied'
  | 'finished'
  | 'failed'

export interface Lead {
  id: string
  firstName: string
  lastName: string
  headline: string
  company: string
  location: string
  profileUrl: string
  email?: string
  status: LeadStatus
  campaignId?: string
  listName: string
  lastAction?: string
  lastActionAt?: string
  tags: string[]
}

export type LeadSource = 'search' | 'sales_nav' | 'urls' | 'csv' | 'existing'

export interface LeadList {
  id: string
  name: string
  source: LeadSource
  leadIds: string[]
  createdAt: string
}

/* ---------- Sequence (workflow) ---------- */

export type ActionKind =
  | 'view_profile'
  | 'follow'
  | 'endorse'
  | 'like_post'
  | 'invite'
  | 'message'
  | 'email'
  | 'find_email'
  | 'withdraw'

export type ConditionKind =
  | 'is_connected'
  | 'accepted_invite'
  | 'replied'
  | 'has_email'
  | 'opened_email'

export type StepKind = ActionKind | 'condition' | 'end'

export interface Delay {
  days: number
  hours: number
}

export interface StepConfig {
  message?: string
  subject?: string
  skillsCount?: number
  condition?: ConditionKind
  /** For conditions: how long to wait for the condition before taking the "No" branch */
  withinDays?: number
}

export interface SequenceStep {
  id: string
  kind: StepKind
  /** Wait before executing this step (relative to the previous step) */
  delay: Delay
  config: StepConfig
  next?: string | null
  yes?: string | null
  no?: string | null
}

export interface Sequence {
  rootId: string | null
  steps: Record<string, SequenceStep>
}

export type BranchKey = 'next' | 'yes' | 'no'

/* ---------- Campaign ---------- */

export interface CampaignSettings {
  dailyInvites: number
  dailyMessages: number
  dailyProfileViews: number
  dailyEmails: number
  workingDays: number[] // 0 = Sun
  startHour: number
  endHour: number
  timezone: string
  skipConnected: boolean
  skipOtherCampaigns: boolean
  stopOnReply: boolean
  emailAccountId?: string
}

export interface CampaignStats {
  invitesSent: number
  accepted: number
  messagesSent: number
  replied: number
  emailsSent: number
  emailsReplied: number
  profileViews: number
}

export interface Campaign {
  id: string
  name: string
  status: CampaignStatus
  createdAt: string
  leadIds: string[]
  contacted: number
  sequence: Sequence
  settings: CampaignSettings
  stats: CampaignStats
}

/* ---------- Activity / Inbox / Team ---------- */

export interface Activity {
  id: string
  type: 'invite' | 'accepted' | 'message' | 'reply' | 'view' | 'email' | 'follow'
  leadName: string
  campaignId: string
  campaignName: string
  at: string
}

export interface ChatMessage {
  id: string
  from: 'me' | 'them'
  text: string
  at: string
}

export interface Conversation {
  id: string
  leadId: string
  name: string
  headline: string
  unread: boolean
  campaignName?: string
  messages: ChatMessage[]
}

export interface TeamMember {
  id: string
  name: string
  email: string
  role: 'Owner' | 'Admin' | 'Member'
  linkedinConnected: boolean
  activeCampaigns: number
  invitedAt: string
}

export interface LinkedInAccount {
  name: string
  headline: string
  connected: boolean
  plan: 'Free' | 'Premium' | 'Sales Navigator'
}
