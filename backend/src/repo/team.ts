import type { LinkedInStatus, Role, TeamInvite, TeamMember } from '../../../shared/types.ts'
import { type DB, all, one } from '../db/index.ts'
import { INVITE_PENDING_SQL, type InviteRow } from './users.ts'
import { iso } from './util.ts'

interface MemberRow {
  id: string
  name: string
  email: string
  role: Role
  created_at: number
  linkedin_status: LinkedInStatus
  active_campaigns: number
}

const MEMBER_SELECT = `
  SELECT u.id, u.name, u.email, u.role, u.created_at,
         COALESCE(la.status, 'disconnected') AS linkedin_status,
         (SELECT COUNT(*) FROM campaigns c WHERE c.user_id = u.id AND c.status = 'active') AS active_campaigns
  FROM users u LEFT JOIN linkedin_accounts la ON la.user_id = u.id`

const toMember = (r: MemberRow): TeamMember => ({
  id: r.id,
  name: r.name,
  email: r.email,
  role: r.role,
  linkedinStatus: r.linkedin_status,
  activeCampaigns: r.active_campaigns,
  createdAt: iso(r.created_at),
})

/** Owner first, then by join date. */
export const listMembers = (db: DB, workspaceId: string) =>
  all<MemberRow>(
    db,
    `${MEMBER_SELECT} WHERE u.workspace_id = ? ORDER BY CASE u.role WHEN 'owner' THEN 0 ELSE 1 END, u.created_at, u.rowid`,
    workspaceId,
  ).map(toMember)

export function getMember(db: DB, workspaceId: string, userId: string): TeamMember | undefined {
  const row = one<MemberRow>(db, `${MEMBER_SELECT} WHERE u.workspace_id = ? AND u.id = ?`, workspaceId, userId)
  return row ? toMember(row) : undefined
}

/** `publicAppUrl` has no trailing slash; empty gives an app-relative link. */
export const inviteUrl = (publicAppUrl: string, token: string) => `${publicAppUrl}/signup?invite=${encodeURIComponent(token)}`

export const toTeamInvite = (r: InviteRow, publicAppUrl: string): TeamInvite => ({
  token: r.token,
  email: r.email,
  role: r.role,
  createdAt: iso(r.created_at),
  url: inviteUrl(publicAppUrl, r.token),
})

/** Pending (not accepted, not expired) invites, newest first. */
export const listPendingInvites = (db: DB, workspaceId: string, publicAppUrl: string, now: number) =>
  all<InviteRow>(
    db,
    `SELECT i.* FROM invites i WHERE i.workspace_id = ? AND ${INVITE_PENDING_SQL} ORDER BY i.created_at DESC, i.rowid DESC`,
    workspaceId,
    now,
  ).map((r) => toTeamInvite(r, publicAppUrl))
