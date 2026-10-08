import type { Role, User } from '../../../shared/types.ts'
import { type DB, one, run } from '../db/index.ts'
import { saveSettings } from './settings.ts'
import { DEFAULT_SETTINGS } from '../../../shared/time.ts'
import { iso } from './util.ts'

export interface UserRow {
  id: string
  workspace_id: string
  email: string
  name: string
  password_hash: string
  role: Role
  created_at: number
}

export interface InviteRow {
  token: string
  workspace_id: string
  email: string
  role: Exclude<Role, 'owner'>
  created_by: string | null
  created_at: number
  /** NULL for invites created before expiry existed: they expire INVITE_TTL_MS after created_at */
  expires_at: number | null
  accepted_at: number | null
}

/** Invite links stop working 7 days after they were created. */
export const INVITE_TTL_MS = 7 * 86_400_000

/** SQL condition (alias `i`, one `?` = now): the invite is not accepted and not expired. */
export const INVITE_PENDING_SQL = `i.accepted_at IS NULL AND COALESCE(i.expires_at, i.created_at + ${INVITE_TTL_MS}) > ?`

export const toUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: r.role,
  workspaceId: r.workspace_id,
  createdAt: iso(r.created_at),
})

export const getUserById = (db: DB, id: string) => one<UserRow>(db, 'SELECT * FROM users WHERE id = ?', id)

/** `users.email` is COLLATE NOCASE, so the lookup is case-insensitive. */
export const getUserByEmail = (db: DB, email: string) => one<UserRow>(db, 'SELECT * FROM users WHERE email = ?', email.trim())

/** The invite if it is neither accepted nor expired at `now`. */
export const getPendingInvite = (db: DB, token: string, now: number) =>
  one<InviteRow & { workspace_name: string }>(
    db,
    `SELECT i.*, w.name AS workspace_name FROM invites i JOIN workspaces w ON w.id = i.workspace_id
     WHERE i.token = ? AND ${INVITE_PENDING_SQL}`,
    token,
    now,
  )

/** Pending invites created by `userId` stop working, e.g. when that admin is removed or demoted. */
export const deletePendingInvitesBy = (db: DB, userId: string) => run(db, 'DELETE FROM invites WHERE created_by = ? AND accepted_at IS NULL', userId)

/** Inserts the user with default settings and a disconnected LinkedIn account. Call inside a transaction. */
export function insertUser(
  db: DB,
  u: { id: string; workspaceId: string; email: string; name: string; passwordHash: string; role: Role },
  now: number,
): UserRow {
  run(
    db,
    'INSERT INTO users (id, workspace_id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    u.id,
    u.workspaceId,
    u.email,
    u.name,
    u.passwordHash,
    u.role,
    now,
  )
  saveSettings(db, u.id, DEFAULT_SETTINGS, now)
  run(db, `INSERT INTO linkedin_accounts (user_id, status, updated_at) VALUES (?, 'disconnected', ?)`, u.id, now)
  return getUserById(db, u.id)!
}
