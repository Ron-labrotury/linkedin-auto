import { sha256 } from '../crypto.ts'
import { type DB, run } from '../db/index.ts'
import { newToken } from '../ids.ts'

/** Creates a session and returns the bearer token. Only its SHA-256 is stored. */
export function createSession(db: DB, userId: string, ttlMs: number, now = Date.now()): string {
  const token = newToken()
  run(db, 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', sha256(token), userId, now, now + ttlMs)
  return token
}

export const deleteSession = (db: DB, tokenHash: string) => run(db, 'DELETE FROM sessions WHERE token_hash = ?', tokenHash)

export const deleteExpiredSessions = (db: DB, now = Date.now()) => run(db, 'DELETE FROM sessions WHERE expires_at <= ?', now)

/** Sign out every other device of the user (after a password change). */
export const revokeOtherSessions = (db: DB, userId: string, keepTokenHash: string) =>
  run(db, 'DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', userId, keepTokenHash)
