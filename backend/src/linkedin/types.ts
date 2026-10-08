/**
 * The contract between the engine / API and whatever talks to LinkedIn.
 * Implementations: playwright.ts (real browser) and simulated.ts (fake, for testing).
 */
import type { LinkedInAccount, LinkedInProfile } from '../../../shared/types.ts'

export type ConnectionStatus = 'connected' | 'pending' | 'not_connected'

export interface ProfileData {
  firstName: string
  lastName: string
  headline: string
  company: string
  location: string
  /** canonical https://www.linkedin.com/in/<id>/ */
  profileUrl: string
  connection: ConnectionStatus
}

export interface SearchPerson {
  profileUrl: string
  firstName: string
  lastName: string
  headline: string
  location: string
}

export interface SearchPage {
  people: SearchPerson[]
  hasMore: boolean
}

export type InviteResult =
  | 'sent'
  /** a note was requested but LinkedIn did not allow one (e.g. free-plan monthly limit); sent without */
  | 'sent_without_note'
  | 'already_connected'
  | 'pending'

export type MessageResult =
  | 'sent'
  /**
   * The thread already ends with our own message with exactly this text (an earlier attempt was
   * delivered but not confirmed, or the process restarted mid-send) – nothing was sent again.
   */
  | 'already_sent'
  /** stopIfRepliedAfter was given and the lead had replied – nothing was sent */
  | 'replied'
  /** not a 1st-degree connection – LinkedIn does not allow messaging */
  | 'not_connected'

export interface ReplyCheck {
  /**
   * Text of the last message this campaign sent to the lead. Only messages written by the lead
   * AFTER our message with this text count as a reply. When null (or not found in the loaded
   * history), only messages by the lead after our most recent own message count – so a
   * conversation that merely has old history from before the campaign is not a reply.
   */
  after: string | null
}

export type LinkedInErrorCode =
  /** cookies no longer valid / LinkedIn wants to log in again – the account must be reconnected */
  | 'session_expired'
  /** LinkedIn throttled us (weekly invite limit, "too many requests", …) */
  | 'rate_limited'
  /**
   * Infrastructure trouble that is not the lead's fault: no network, browser failed to start or
   * crashed, every page timing out. The engine backs off the whole user and retries the same step
   * later without counting an attempt against the lead.
   */
  | 'transient'
  /**
   * The LinkedIn account needs the user's attention before anything can run (e.g. LinkedIn's
   * interface language is not English, account restricted). The message is shown to the user;
   * the engine stops for the user (account status 'error') without penalising the lead.
   */
  | 'account_problem'
  /** profile does not exist / is not visible */
  | 'not_found'
  /** the action is not possible for this profile (button missing, e.g. no Follow) */
  | 'action_unavailable'
  | 'unknown'

export class LinkedInError extends Error {
  readonly code: LinkedInErrorCode
  constructor(code: LinkedInErrorCode, message: string) {
    super(message)
    this.name = 'LinkedInError'
    this.code = code
  }
}

/** One logged-in LinkedIn session. Every method may throw LinkedInError. */
export interface LinkedInDriver {
  viewProfile(profileUrl: string): Promise<ProfileData>
  getConnectionStatus(profileUrl: string): Promise<ConnectionStatus>
  /** note: null = no note */
  sendInvite(profileUrl: string, note: string | null): Promise<InviteResult>
  /**
   * Send `text` in the 1:1 thread with this person. Idempotent: returns 'already_sent' instead of
   * sending when the thread already ends with our own message with the same text.
   * With `stopIfRepliedAfter` set (a ReplyCheck), returns 'replied' without sending when the lead replied.
   */
  sendMessage(profileUrl: string, text: string, opts: { stopIfRepliedAfter?: ReplyCheck }): Promise<MessageResult>
  /** true if the lead wrote to us in the 1:1 thread (see ReplyCheck for what counts) */
  hasReplied(profileUrl: string, check: ReplyCheck): Promise<boolean>
  follow(profileUrl: string): Promise<'followed' | 'already_following'>
  likeLatestPost(profileUrl: string): Promise<'liked' | 'already_liked' | 'no_posts'>
  withdrawInvite(profileUrl: string): Promise<'withdrawn' | 'not_pending'>
  /** One page (1-based) of a people-search URL. */
  searchPeople(searchUrl: string, page: number): Promise<SearchPage>
}

export interface ConnectOutcome {
  account: LinkedInAccount
  message: string
}

/**
 * Owns LinkedIn sessions per app user: connecting (password + verification code, or li_at cookie),
 * persisting the encrypted session, and handing out drivers to the engine.
 */
export interface LinkedInService {
  readonly kind: 'playwright' | 'simulated'
  getAccount(userId: string): LinkedInAccount
  loginWithPassword(userId: string, email: string, password: string): Promise<ConnectOutcome>
  /** Code from email / SMS / authenticator after status "needs_verification". */
  submitVerificationCode(userId: string, code: string): Promise<ConnectOutcome>
  /** Re-check a pending "needs_app_approval" login (user approved in the LinkedIn app). */
  checkPendingLogin(userId: string): Promise<ConnectOutcome>
  connectWithCookie(userId: string, liAt: string): Promise<ConnectOutcome>
  /** Open LinkedIn with the stored session and confirm it is logged in; refreshes the profile. */
  test(userId: string): Promise<{ ok: boolean; message: string; account: LinkedInAccount }>
  disconnect(userId: string): Promise<void>
  /**
   * Run `fn` with a driver bound to the user's session. Calls for the same user are serialized.
   * Throws LinkedInError('session_expired') when there is no usable session (and marks the account expired).
   */
  withDriver<T>(userId: string, fn: (driver: LinkedInDriver) => Promise<T>): Promise<T>
  shutdown(): Promise<void>
}

export type { LinkedInProfile }
