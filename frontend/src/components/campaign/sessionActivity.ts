/**
 * Readable text for failed "session" activities: account-wide LinkedIn trouble the engine records once
 * (not tied to a lead). Pure (tested).
 */

export type SessionProblem = 'unreachable' | 'expired' | 'account'

/**
 * What a failed session activity is about, from its message:
 * - unreachable: network / browser / server trouble – the engine retries by itself in 10–20 minutes
 * - expired: LinkedIn signed the account out – the user must reconnect
 * - account: LinkedIn reported a problem the user must fix (e.g. LinkedIn not in English)
 */
export function sessionProblem(detail: string): SessionProblem {
  if (/couldn[’']?t reach|could not reach|took too long|browser|server is (busy|shutting down)|network|internet|\bERR_[A-Z_]+|timed? ?out/i.test(detail)) return 'unreachable'
  if (/expired|signed (this account|you) out|log ?in again|reconnect|not valid|security verification|connect your linkedin account first/i.test(detail)) return 'expired'
  return 'account'
}

export const SESSION_PROBLEM_TEXT: Record<SessionProblem, { title: string; hint: string; tone: 'warn' | 'bad'; settingsLink: boolean }> = {
  unreachable: {
    title: 'Couldn’t reach LinkedIn',
    hint: 'Not the lead’s fault and no attempt was counted – your campaigns try again automatically in 10–20 minutes.',
    tone: 'warn',
    settingsLink: false,
  },
  expired: {
    title: 'Your LinkedIn session expired',
    hint: 'Campaigns are on hold until you reconnect LinkedIn.',
    tone: 'bad',
    settingsLink: true,
  },
  account: {
    title: 'Your LinkedIn account needs attention',
    hint: 'Campaigns are on hold until it’s fixed – then test or reconnect the account.',
    tone: 'bad',
    settingsLink: true,
  },
}
