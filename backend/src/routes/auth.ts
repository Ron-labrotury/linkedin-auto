import { Router, type RequestHandler, type Response } from 'express'
import { z } from 'zod'
import type { AuthResponse, Role } from '../../../shared/types.ts'
import { type DB, run, tx } from '../db/index.ts'
import { newId } from '../ids.ts'
import { HttpError } from '../http/errors.ts'
import { body, isUniqueViolation } from '../http/request.ts'
import { emailSchema, newPasswordSchema, personNameSchema } from '../http/schemas.ts'
import type { AppDeps } from '../http/types.ts'
import { auth } from '../auth/middleware.ts'
import { dummyHash, hashPassword, verifyPassword } from '../auth/password.ts'
import { createFailureWindow, createLoginLimiter, ipBucket } from '../auth/rate-limit.ts'
import { createSession, deleteExpiredSessions, deleteSession, revokeOtherSessions } from '../auth/sessions.ts'
import { getPendingInvite, getUserByEmail, getUserById, insertUser, toUser } from '../repo/users.ts'

/** Wrong current passwords allowed per user per window on POST /auth/password. */
const MAX_PASSWORD_FAILURES = 5
const LIMIT_WINDOW_MS = 15 * 60_000

const signupSchema = z.object({
  name: personNameSchema,
  email: emailSchema,
  password: newPasswordSchema,
  inviteToken: z.string().trim().max(200).nullish(),
})

const loginSchema = z.object({
  email: z.string('Enter your email').trim().toLowerCase().min(1, 'Enter your email').max(254, 'Email address is too long'),
  password: z.string('Enter your password').min(1, 'Enter your password').max(1000, 'Password is too long'),
})

const passwordSchema = z.object({
  currentPassword: z.string('Enter your current password').min(1, 'Enter your current password').max(1000),
  newPassword: newPasswordSchema,
})

const emailTaken = () => new HttpError(409, 'An account with this email already exists', { email: 'This email is already registered' })

const INVALID_INVITE = 'This invite link is invalid, has expired or has already been used'

/** 429 with Retry-After for a limiter wait of `waitMs`. */
function tooMany(res: Response, waitMs: number, what: string) {
  const minutes = Math.max(1, Math.ceil(waitMs / 60_000))
  res.set('Retry-After', String(Math.ceil(waitMs / 1000)))
  return new HttpError(429, `Too many ${what}. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`)
}

export function authRouter({ db, config }: AppDeps, requireAuth: RequestHandler) {
  const r = Router()
  const limiter = createLoginLimiter({ windowMs: LIMIT_WINDOW_MS })
  // wrong current passwords per user id: a stolen session token must not become a password oracle
  const passwordFailures = createFailureWindow({ max: MAX_PASSWORD_FAILURES, windowMs: LIMIT_WINDOW_MS, maxKeys: 50_000, now: Date.now })

  r.post('/signup', async (req, res) => {
    const input = signupSchema.parse(body(req))
    if (getUserByEmail(db, input.email)) throw emailTaken()
    const passwordHash = await hashPassword(input.password)
    const now = Date.now()
    let out: AuthResponse
    try {
      out = tx(db, () => signup(db, { ...input, passwordHash }, config.sessionTtlMs, now))
    } catch (e) {
      if (isUniqueViolation(e)) throw emailTaken()
      throw e
    }
    res.status(201).json(out)
  })

  r.post('/login', async (req, res) => {
    const input = loginSchema.parse(body(req))
    // req.ip honours X-Forwarded-For only for the configured proxy hops (config.trustProxy)
    const ip = ipBucket(req.ip)
    const wait = limiter.blockedFor(input.email, ip)
    if (wait > 0) throw tooMany(res, wait, 'failed sign-in attempts')
    // counted before the slow password check so concurrent requests can't all slip past the limit
    limiter.fail(input.email, ip)
    const user = getUserByEmail(db, input.email)
    const ok = await verifyPassword(input.password, user?.password_hash ?? (await dummyHash()))
    if (!user || !ok) throw new HttpError(401, 'Invalid email or password')
    limiter.reset(input.email, ip)
    const now = Date.now()
    deleteExpiredSessions(db, now)
    const token = createSession(db, user.id, config.sessionTtlMs, now)
    res.json({ token, user: toUser(user) } satisfies AuthResponse)
  })

  r.get('/invite/:token', (req, res) => {
    const invite = getPendingInvite(db, req.params.token, Date.now())
    if (!invite) throw new HttpError(404, INVALID_INVITE)
    res.json({ email: invite.email, workspaceName: invite.workspace_name, role: invite.role })
  })

  r.post('/logout', requireAuth, (req, res) => {
    deleteSession(db, auth(req).tokenHash)
    res.status(204).end()
  })

  r.get('/me', requireAuth, (req, res) => {
    res.json(auth(req).user)
  })

  r.patch('/me', requireAuth, (req, res) => {
    const { name } = z.object({ name: personNameSchema }).parse(body(req))
    const { user } = auth(req)
    run(db, 'UPDATE users SET name = ? WHERE id = ?', name, user.id)
    res.json(toUser(getUserById(db, user.id)!))
  })

  r.post('/password', requireAuth, async (req, res) => {
    const input = passwordSchema.parse(body(req))
    const { user, tokenHash } = auth(req)
    const wait = passwordFailures.blockedFor(user.id)
    if (wait > 0) throw tooMany(res, wait, 'incorrect password attempts')
    passwordFailures.fail(user.id) // counted up front, like logins; cleared below when correct
    const row = getUserById(db, user.id)!
    // 400 (not 401): a wrong current password must not sign the user out
    if (!(await verifyPassword(input.currentPassword, row.password_hash)))
      throw new HttpError(400, 'Current password is incorrect', { currentPassword: 'Current password is incorrect' })
    passwordFailures.clear(user.id)
    const hash = await hashPassword(input.newPassword)
    tx(db, () => {
      run(db, 'UPDATE users SET password_hash = ? WHERE id = ?', hash, user.id)
      revokeOtherSessions(db, user.id, tokenHash)
    })
    res.status(204).end()
  })

  return r
}

/** Creates (or joins) the workspace, the user with defaults, and a session. Runs inside a transaction. */
function signup(
  db: DB,
  input: { name: string; email: string; passwordHash: string; inviteToken?: string | null },
  ttlMs: number,
  now: number,
): AuthResponse {
  if (getUserByEmail(db, input.email)) throw emailTaken()
  let workspaceId: string
  let role: Role
  if (input.inviteToken) {
    const invite = getPendingInvite(db, input.inviteToken, now)
    if (!invite) throw new HttpError(400, INVALID_INVITE, { inviteToken: 'Invalid, expired or used invite' })
    if (invite.email.toLowerCase() !== input.email)
      throw new HttpError(400, `This invite was sent to ${invite.email}. Sign up with that email address.`, { email: 'Use the invited email address' })
    const claimed = run(db, 'UPDATE invites SET accepted_at = ? WHERE token = ? AND accepted_at IS NULL', now, invite.token)
    if (claimed.changes !== 1) throw new HttpError(400, INVALID_INVITE, { inviteToken: 'Invalid, expired or used invite' })
    workspaceId = invite.workspace_id
    role = invite.role
  } else {
    workspaceId = newId('ws')
    role = 'owner'
    run(db, 'INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', workspaceId, `${input.name}'s workspace`, now)
  }
  const user = insertUser(db, { id: newId('usr'), workspaceId, email: input.email, name: input.name, passwordHash: input.passwordHash, role }, now)
  const token = createSession(db, user.id, ttlMs, now)
  return { token, user: toUser(user) }
}
