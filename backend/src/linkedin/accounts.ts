/**
 * Persistence of the per-user LinkedIn account (linkedin_accounts row ⇄ LinkedInAccount DTO).
 * The session (Playwright storageState, or a marker for the simulated driver) is stored only
 * encrypted in session_enc. The LinkedIn password is never stored.
 */
import type { LinkedInAccount, LinkedInProfile, LinkedInStatus } from '../../../shared/types.ts'
import { decrypt, encrypt } from '../crypto.ts'
import { type DB, one, run, toIso, tx } from '../db/index.ts'

interface AccountRow {
  status: string
  auth_method: string | null
  email: string | null
  session_enc: string | null
  profile_json: string | null
  last_checked_at: number | null
  last_error: string | null
}

const STATUSES: LinkedInStatus[] = ['disconnected', 'connected', 'needs_verification', 'needs_app_approval', 'expired', 'error']

export const UNREADABLE_SESSION = 'Your saved LinkedIn session could not be read. Please reconnect your account.'

export const disconnectedAccount = (): LinkedInAccount => ({
  status: 'disconnected',
  authMethod: null,
  email: null,
  profile: null,
  lastCheckedAt: null,
  lastError: null,
})

function parseProfile(json: string | null): LinkedInProfile | null {
  if (!json) return null
  try {
    const p = JSON.parse(json) as Partial<LinkedInProfile>
    if (!p || typeof p !== 'object') return null
    return {
      name: String(p.name ?? ''),
      headline: String(p.headline ?? ''),
      profileUrl: String(p.profileUrl ?? ''),
      imageUrl: p.imageUrl ? String(p.imageUrl) : null,
    }
  } catch {
    return null
  }
}

function toDto(row: AccountRow | undefined): LinkedInAccount {
  if (!row) return disconnectedAccount()
  return {
    status: STATUSES.includes(row.status as LinkedInStatus) ? (row.status as LinkedInStatus) : 'disconnected',
    authMethod: row.auth_method === 'password' || row.auth_method === 'cookie' ? row.auth_method : null,
    email: row.email,
    profile: parseProfile(row.profile_json),
    lastCheckedAt: toIso(row.last_checked_at),
    lastError: row.last_error,
  }
}

const selectRow = (db: DB, userId: string) =>
  one<AccountRow>(
    db,
    `SELECT status, auth_method, email, session_enc, profile_json, last_checked_at, last_error
     FROM linkedin_accounts WHERE user_id = ?`,
    userId,
  )

/** The stored account as-is (a missing row reads as disconnected). */
export function readAccount(db: DB, userId: string): LinkedInAccount {
  return toDto(selectRow(db, userId))
}

/** The account for display: a "connected" account whose session can't be read is reported (and stored) as expired. */
export function getAccount(db: DB, userId: string): LinkedInAccount {
  const row = selectRow(db, userId)
  if (row?.status === 'connected' && (!row.session_enc || decrypt(row.session_enc) === null)) {
    return markExpired(db, userId, UNREADABLE_SESSION, { clearSession: !!row.session_enc })
  }
  return toDto(row)
}

export interface AccountPatch {
  status?: LinkedInStatus
  authMethod?: 'password' | 'cookie' | null
  email?: string | null
  profile?: LinkedInProfile | null
  lastCheckedAt?: number | null
  lastError?: string | null
  /** Any JSON-serialisable session; stored encrypted. null clears it. */
  session?: unknown
}

/** Update the account (creating the row if it does not exist yet). Undefined fields are left unchanged. */
export function updateAccount(db: DB, userId: string, patch: AccountPatch, now = Date.now()): LinkedInAccount {
  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [now]
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`)
    params.push(v)
  }
  if (patch.status !== undefined) set('status', patch.status)
  if (patch.authMethod !== undefined) set('auth_method', patch.authMethod)
  if (patch.email !== undefined) set('email', patch.email)
  if (patch.profile !== undefined) set('profile_json', patch.profile ? JSON.stringify(patch.profile) : null)
  if (patch.lastCheckedAt !== undefined) set('last_checked_at', patch.lastCheckedAt)
  if (patch.lastError !== undefined) set('last_error', patch.lastError)
  if (patch.session !== undefined) set('session_enc', patch.session === null ? null : encrypt(JSON.stringify(patch.session)))
  tx(db, () => {
    run(
      db,
      `INSERT INTO linkedin_accounts (user_id, status, updated_at) VALUES (?, 'disconnected', ?)
       ON CONFLICT(user_id) DO NOTHING`,
      userId,
      now,
    )
    run(db, `UPDATE linkedin_accounts SET ${sets.join(', ')} WHERE user_id = ?`, ...params, userId)
  })
  return readAccount(db, userId)
}

/**
 * The decrypted session, or null when there is none. A session that can't be decrypted / parsed
 * (e.g. APP_SECRET changed) is cleared and the account is marked expired.
 */
export function loadSession<T = unknown>(db: DB, userId: string): T | null {
  const row = one<{ session_enc: string | null }>(db, 'SELECT session_enc FROM linkedin_accounts WHERE user_id = ?', userId)
  if (!row?.session_enc) return null
  const plain = decrypt(row.session_enc)
  if (plain !== null) {
    try {
      return JSON.parse(plain) as T
    } catch {
      /* fall through */
    }
  }
  markExpired(db, userId, UNREADABLE_SESSION, { clearSession: true })
  return null
}

export function saveSession(db: DB, userId: string, session: unknown) {
  updateAccount(db, userId, { session })
}

/** Status "expired" with a reason. The profile is kept so the UI can still show who was connected. */
export function markExpired(db: DB, userId: string, message: string, opts: { clearSession?: boolean } = {}) {
  return updateAccount(db, userId, { status: 'expired', lastError: message, ...(opts.clearSession ? { session: null } : {}) })
}

/** Forget the session and profile. */
export function clearAccount(db: DB, userId: string) {
  return updateAccount(db, userId, {
    status: 'disconnected',
    authMethod: null,
    profile: null,
    session: null,
    lastError: null,
  })
}
