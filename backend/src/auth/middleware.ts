import type { Request, RequestHandler } from 'express'
import type { User } from '../../../shared/types.ts'
import { sha256 } from '../crypto.ts'
import { type DB, one, run } from '../db/index.ts'
import { HttpError } from '../http/errors.ts'
import { type UserRow, toUser } from '../repo/users.ts'
import { deleteSession } from './sessions.ts'

export interface AuthContext {
  user: User
  tokenHash: string
}

const contexts = new WeakMap<Request, AuthContext>()

/** The signed-in user of a request that went through `requireAuth`. */
export function auth(req: Request): AuthContext {
  const ctx = contexts.get(req)
  if (!ctx) throw new HttpError(401, 'Sign in to continue')
  return ctx
}

/** Owners and admins manage the team. */
export const canManageTeam = (user: User) => user.role === 'owner' || user.role === 'admin'

/**
 * Validates "Authorization: Bearer <token>" against the sessions table. Sessions slide: once less
 * than half of the TTL is left, using the session extends it to a full TTL again.
 */
export function createRequireAuth(deps: { db: DB; ttlMs: number; now?: () => number }): RequestHandler {
  const { db, ttlMs } = deps
  const now = deps.now ?? Date.now
  return (req, _res, next) => {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.get('authorization') ?? '')
    if (!m) throw new HttpError(401, 'Sign in to continue')
    const tokenHash = sha256(m[1])
    const row = one<UserRow & { expires_at: number }>(
      db,
      'SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
      tokenHash,
    )
    if (!row) throw new HttpError(401, 'Your session has ended. Please sign in again.')
    const t = now()
    if (row.expires_at <= t) {
      deleteSession(db, tokenHash)
      throw new HttpError(401, 'Your session has expired. Please sign in again.')
    }
    if (row.expires_at - t < ttlMs / 2) run(db, 'UPDATE sessions SET expires_at = ? WHERE token_hash = ?', t + ttlMs, tokenHash)
    contexts.set(req, { user: toUser(row), tokenHash })
    next()
  }
}
