/**
 * Types shared by the frontend and the backend. This file is the data contract:
 * the API sends and receives exactly these shapes (JSON).
 *
 * Plain TypeScript only (no enums / namespaces / runtime code) so Node can run it
 * with type stripping and Vite can bundle it.
 */

/* ------------------------------------------------------------------ */
/* Sequence                                                            */
/* ------------------------------------------------------------------ */

export type ActionKind = 'view_profile' | 'follow' | 'like_post' | 'invite' | 'message' | 'withdraw'

export type ConditionKind = 'accepted_invite' | 'is_connected' | 'replied'

export type StepKind = ActionKind | 'condition' | 'end'

export type DelayUnit = 'minutes' | 'hours' | 'days'

/** Wait a random amount between `min` and `max` (inclusive) of `unit` before the step runs. */
export interface Delay {
  min: number
  max: number
  unit: DelayUnit
}

export interface Duration {
  value: number
  unit: DelayUnit
}

export interface StepConfig {
  /** invite note (optional, <= 300 chars) or message text (required) */
  message?: string
  condition?: ConditionKind
  /** Conditions: how long to keep checking before taking the "No" branch. */
  within?: Duration
}

export interface SequenceStep {
  id: string
  kind: StepKind
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

/* ------------------------------------------------------------------ */
/* Users, workspace, settings                                          */
/* ------------------------------------------------------------------ */

export type Role = 'owner' | 'admin' | 'member'

export interface User {
  id: string
  email: string
  name: string
  role: Role
  workspaceId: string
  createdAt: string
}

export interface AuthResponse {
  token: string
  user: User
}

/** Per-user settings. Active hours apply to every campaign of the user. */
export interface UserSettings {
  /** IANA time zone, e.g. "Asia/Kolkata" */
  timezone: string
  /** 0 = Sunday … 6 = Saturday */
  activeDays: number[]
  /** "HH:MM" 24h, inclusive start */
  activeStart: string
  /** "HH:MM" 24h, exclusive end; must be after activeStart */
  activeEnd: string
  /** Random pause between any two LinkedIn actions, in minutes (min <= max). Default 1–5. */
  gapMinMinutes: number
  gapMaxMinutes: number
}

/* ------------------------------------------------------------------ */
/* LinkedIn account                                                    */
/* ------------------------------------------------------------------ */

export type LinkedInStatus =
  | 'disconnected'
  | 'connected'
  /** waiting for the email / SMS / authenticator code LinkedIn asked for */
  | 'needs_verification'
  /** waiting for the user to approve the sign-in in the LinkedIn mobile app */
  | 'needs_app_approval'
  /** session no longer valid – user must reconnect */
  | 'expired'
  | 'error'

export interface LinkedInProfile {
  name: string
  headline: string
  profileUrl: string
  imageUrl: string | null
}

export interface LinkedInAccount {
  status: LinkedInStatus
  authMethod: 'password' | 'cookie' | null
  email: string | null
  profile: LinkedInProfile | null
  lastCheckedAt: string | null
  lastError: string | null
}

export interface LinkedInConnectResponse {
  account: LinkedInAccount
  /** Human-readable explanation of the status (e.g. "Enter the code LinkedIn emailed you"). */
  message: string
}

export interface LinkedInTestResponse {
  ok: boolean
  message: string
  account: LinkedInAccount
}

/* ------------------------------------------------------------------ */
/* Campaigns & leads                                                   */
/* ------------------------------------------------------------------ */

export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed'

export interface CampaignSettings {
  dailyInvites: number
  dailyMessages: number
  dailyProfileViews: number
  /** Do not invite leads who are already 1st-degree connections (the invite step is skipped). */
  skipConnected: boolean
  /** Skip leads that are already in another active campaign of the same user. */
  skipOtherCampaigns: boolean
  /** Stop the sequence for a lead once they reply on LinkedIn. */
  stopOnReply: boolean
}

export interface CampaignStats {
  totalLeads: number
  /** leads that received at least one action */
  contacted: number
  invitesSent: number
  accepted: number
  messagesSent: number
  replied: number
  profileViews: number
  failed: number
}

export interface CampaignSummary {
  id: string
  name: string
  status: CampaignStatus
  createdAt: string
  updatedAt: string
  stats: CampaignStats
  /** number of steps (excluding "end") */
  stepCount: number
  /** search imports still collecting leads */
  pendingImports: number
}

export interface Campaign extends CampaignSummary {
  sequence: Sequence
  settings: CampaignSettings
  imports: LeadImport[]
}

export type LeadStatus =
  | 'queued' //        waiting for its first step
  | 'in_progress' //   sequence running, no invite yet
  | 'invited' //       invite sent, not accepted yet
  | 'connected' //     1st-degree connection
  | 'replied' //       replied on LinkedIn
  | 'finished' //      reached the end of the sequence
  | 'skipped' //       excluded (duplicate / already connected / in another campaign)
  | 'failed' //        an action failed repeatedly

export interface Lead {
  id: string
  campaignId: string
  firstName: string
  lastName: string
  headline: string
  company: string
  location: string
  profileUrl: string
  status: LeadStatus
  listName: string
  currentStepId: string | null
  /** ISO time the next step is due, null when the lead is done */
  nextActionAt: string | null
  lastAction: string | null
  lastActionAt: string | null
  error: string | null
  createdAt: string
}

/** A lead as submitted by the client when creating a campaign / adding leads. */
export interface LeadInput {
  profileUrl: string
  firstName?: string
  lastName?: string
  headline?: string
  company?: string
  location?: string
  listName?: string
}

export interface SearchImportInput {
  /** https://www.linkedin.com/search/results/people/?… */
  url: string
  /** max leads to collect (1–1000) */
  max: number
  listName?: string
}

export type ImportStatus = 'pending' | 'running' | 'done' | 'failed'

export interface LeadImport {
  id: string
  url: string
  max: number
  collected: number
  status: ImportStatus
  listName: string
  error: string | null
  createdAt: string
}

export interface CreateCampaignInput {
  name: string
  status: 'active' | 'draft'
  sequence: Sequence
  settings: CampaignSettings
  leads: LeadInput[]
  searchImports: SearchImportInput[]
}

export interface UpdateCampaignInput {
  name?: string
  status?: CampaignStatus
  sequence?: Sequence
  settings?: CampaignSettings
}

export interface AddLeadsInput {
  leads: LeadInput[]
  searchImports: SearchImportInput[]
}

export interface AddLeadsResponse {
  added: number
  /** duplicates within the campaign, invalid URLs, or leads in another active campaign */
  skipped: number
  imports: number
}

export interface LeadsPage {
  leads: Lead[]
  total: number
}

/* ------------------------------------------------------------------ */
/* Activity & dashboard                                                */
/* ------------------------------------------------------------------ */

export type ActivityType =
  | 'view_profile'
  | 'follow'
  | 'like_post'
  | 'invite'
  | 'message'
  | 'withdraw'
  | 'accepted' //   detected acceptance of an invite
  | 'replied' //    detected reply
  | 'condition' //  condition evaluated
  | 'import' //     a page of search results collected
  | 'session' //    LinkedIn session events (expired, verified …)

export interface Activity {
  id: string
  type: ActivityType
  status: 'success' | 'failed' | 'skipped'
  campaignId: string | null
  campaignName: string | null
  leadId: string | null
  leadName: string | null
  stepId: string | null
  detail: string
  createdAt: string
}

export interface LimitUsage {
  done: number
  limit: number
}

export interface Dashboard {
  linkedin: LinkedInAccount
  today: {
    invites: LimitUsage
    messages: LimitUsage
    profileViews: LimitUsage
  }
  /** invites sent by campaigns that are not accepted yet */
  pendingInvites: number
  accepted: number
  replies: number
  /** whether "now" is inside the user's active hours */
  withinActiveHours: boolean
  /** next time the engine may act for this user (gap / active hours), null if idle */
  nextActionAt: string | null
  activity: Activity[]
  campaigns: CampaignSummary[]
}

/* ------------------------------------------------------------------ */
/* Team                                                                */
/* ------------------------------------------------------------------ */

export interface TeamMember {
  id: string
  name: string
  email: string
  role: Role
  linkedinStatus: LinkedInStatus
  activeCampaigns: number
  createdAt: string
}

export interface TeamInvite {
  token: string
  email: string
  role: Exclude<Role, 'owner'>
  createdAt: string
  /** absolute or app-relative URL the invitee opens to sign up, e.g. "/signup?invite=<token>" */
  url: string
}

export interface Team {
  workspaceName: string
  members: TeamMember[]
  invites: TeamInvite[]
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Every non-2xx API response has this body. */
export interface ApiError {
  error: string
  /** optional field-level details */
  details?: Record<string, string>
}
