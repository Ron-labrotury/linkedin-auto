import { Router } from 'express'
import { z } from 'zod'
import type { Team } from '../../../shared/types.ts'
import { one, run, tx } from '../db/index.ts'
import { newToken } from '../ids.ts'
import { HttpError } from '../http/errors.ts'
import { body } from '../http/request.ts'
import { emailSchema } from '../http/schemas.ts'
import type { AppDeps } from '../http/types.ts'
import { auth, canManageTeam } from '../auth/middleware.ts'
import { getMember, listMembers, listPendingInvites, toTeamInvite } from '../repo/team.ts'
import { INVITE_TTL_MS, type InviteRow, deletePendingInvitesBy, getUserByEmail } from '../repo/users.ts'

const roleSchema = z.enum(['admin', 'member'], 'Role must be "admin" or "member"')
const inviteSchema = z.object({ email: emailSchema, role: roleSchema })

export function teamRouter({ db, linkedin, config }: AppDeps) {
  const r = Router()

  const requireManager = (req: Parameters<typeof auth>[0]) => {
    const ctx = auth(req)
    if (!canManageTeam(ctx.user)) throw new HttpError(403, 'Only the workspace owner or an admin can manage the team')
    return ctx
  }

  r.get('/', (req, res) => {
    const { user } = auth(req)
    const ws = one<{ name: string }>(db, 'SELECT name FROM workspaces WHERE id = ?', user.workspaceId)
    const team: Team = {
      workspaceName: ws?.name ?? '',
      members: listMembers(db, user.workspaceId),
      // invite links grant access to the workspace, so only managers see them
      invites: canManageTeam(user) ? listPendingInvites(db, user.workspaceId, config.publicAppUrl, Date.now()) : [],
    }
    res.json(team)
  })

  r.post('/invites', (req, res) => {
    const { user } = requireManager(req)
    const input = inviteSchema.parse(body(req))
    if (getUserByEmail(db, input.email)) throw new HttpError(409, 'Someone with this email already has an account', { email: 'Already has an account' })
    const now = Date.now()
    const invite = tx(db, () => {
      // a new invite for the same address replaces the pending one (e.g. to change the role)
      run(db, 'DELETE FROM invites WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL', user.workspaceId, input.email)
      const token = newToken()
      run(
        db,
        'INSERT INTO invites (token, workspace_id, email, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        token,
        user.workspaceId,
        input.email,
        input.role,
        user.id,
        now,
        now + INVITE_TTL_MS,
      )
      return one<InviteRow>(db, 'SELECT * FROM invites WHERE token = ?', token)!
    })
    res.status(201).json(toTeamInvite(invite, config.publicAppUrl))
  })

  r.delete('/invites/:token', (req, res) => {
    const { user } = requireManager(req)
    const out = run(db, 'DELETE FROM invites WHERE token = ? AND workspace_id = ? AND accepted_at IS NULL', req.params.token, user.workspaceId)
    if (!out.changes) throw new HttpError(404, 'Invite not found')
    res.status(204).end()
  })

  r.patch('/members/:id', (req, res) => {
    const { user } = auth(req)
    if (user.role !== 'owner') throw new HttpError(403, 'Only the workspace owner can change roles')
    const { role } = z.object({ role: roleSchema }).parse(body(req))
    const target = getMember(db, user.workspaceId, req.params.id)
    if (!target) throw new HttpError(404, 'Member not found')
    if (target.role === 'owner') throw new HttpError(422, 'The owner’s role can’t be changed')
    tx(db, () => {
      run(db, 'UPDATE users SET role = ? WHERE id = ?', role, target.id)
      // a demoted admin's invite links must not keep granting access (possibly as admin)
      if (role === 'member') deletePendingInvitesBy(db, target.id)
    })
    res.json(getMember(db, user.workspaceId, target.id))
  })

  r.delete('/members/:id', async (req, res) => {
    const { user } = requireManager(req)
    const target = getMember(db, user.workspaceId, req.params.id)
    if (!target) throw new HttpError(404, 'Member not found')
    if (target.role === 'owner') throw new HttpError(422, 'The workspace owner can’t be removed')
    if (target.id === user.id) throw new HttpError(422, 'You can’t remove yourself')
    // close the browser session first so the engine stops acting for this user
    await linkedin.disconnect(target.id).catch((e: unknown) => {
      console.warn(`[team] disconnecting LinkedIn for removed user ${target.id} failed: ${e instanceof Error ? e.message : String(e)}`)
    })
    tx(db, () => {
      // invites.created_by is ON DELETE SET NULL: drop the removed user's pending invite links first,
      // or they could use one to rejoin the workspace
      deletePendingInvitesBy(db, target.id)
      run(db, 'DELETE FROM users WHERE id = ?', target.id) // cascades: sessions, settings, account, campaigns, leads, imports, activities
    })
    res.status(204).end()
  })

  return r
}
