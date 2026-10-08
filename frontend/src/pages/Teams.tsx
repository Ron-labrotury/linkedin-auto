import { useState, type FormEvent } from 'react'
import { Link2, ShieldCheck, Trash2, UserPlus, Users } from 'lucide-react'
import type { TeamInvite, TeamMember } from '@shared/types.ts'
import { ApiError, errorMessage } from '../api/client'
import { useInviteMember, useRemoveMember, useRevokeInvite, useTeam, useUpdateMember } from '../api/hooks-account'
import { useAuth } from '../auth/context'
import { absoluteUrl } from '../auth/links'
import { LINKEDIN_STATUS, StatusDot } from '../components/linkedin/status'
import { Alert, Avatar, Badge, Button, Card, ConfirmModal, CopyButton, ErrorState, Field, Input, PageHeader, Select, Skeleton } from '../components/ui'
import { toast } from '../lib/toast'
import { cn, formatDate, timeAgo } from '../lib/utils'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member' } as const
const ROLE_TONE = { owner: 'brand', admin: 'info', member: 'neutral' } as const
const inviteLink = (invite: TeamInvite) => absoluteUrl(invite.url, window.location.origin)

function MemberRow({ member, meId, isOwner, canManage, onRemove }: { member: TeamMember; meId: string; isOwner: boolean; canManage: boolean; onRemove: (m: TeamMember) => void }) {
  const update = useUpdateMember()
  const isMe = member.id === meId
  const editableRole = isOwner && member.role !== 'owner'
  const canRemove = canManage && member.role !== 'owner' && !isMe
  const li = LINKEDIN_STATUS[member.linkedinStatus]

  return (
    <li className="flex flex-col gap-3 py-4 @3xl:flex-row @3xl:items-center @3xl:gap-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar name={member.name} size={40} />
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-semibold">
            <span className="truncate">{member.name}</span>
            {isMe && <Badge>You</Badge>}
          </p>
          <p className="truncate text-sm text-ink-3">{member.email}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pl-[52px] text-sm @3xl:flex-nowrap @3xl:pl-0">
        <span className="flex items-center gap-2 text-ink-2 @3xl:w-48" title={`LinkedIn: ${li.label}`}>
          <StatusDot status={member.linkedinStatus} />
          <span>LinkedIn {li.label.toLowerCase()}</span>
        </span>
        <span className="text-ink-2 @3xl:w-36">
          {member.activeCampaigns} active campaign{member.activeCampaigns === 1 ? '' : 's'}
        </span>
        <span className="hidden text-ink-3 @5xl:inline @5xl:w-32">Since {formatDate(member.createdAt)}</span>
        <span className="flex w-28 items-center">
          {editableRole ? (
            <Select
              aria-label={`Role for ${member.name}`}
              value={member.role}
              disabled={update.isPending}
              onChange={(e) =>
                update.mutate(
                  { id: member.id, role: e.target.value as 'admin' | 'member' },
                  {
                    onSuccess: (m) => toast(`${m.name} is now ${m.role === 'admin' ? 'an admin' : 'a member'}`, 'success'),
                    onError: (err) => toast(errorMessage(err), 'error'),
                  },
                )
              }
              className="h-8 text-xs"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </Select>
          ) : (
            <Badge tone={ROLE_TONE[member.role]}>{ROLE_LABEL[member.role]}</Badge>
          )}
        </span>
        {canManage && (
          <button
            type="button"
            onClick={() => onRemove(member)}
            disabled={!canRemove}
            className="cursor-pointer rounded-md p-1.5 text-ink-3 hover:bg-bad/10 hover:text-bad disabled:invisible"
            aria-label={`Remove ${member.name}`}
            title={`Remove ${member.name}`}
          >
            <Trash2 size={17} />
          </button>
        )}
      </div>
    </li>
  )
}

function InviteForm() {
  const invite = useInviteMember()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'member'>('member')
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [created, setCreated] = useState<TeamInvite | null>(null)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const value = email.trim()
    if (!EMAIL_RE.test(value)) {
      setError(value ? 'Enter a valid email address' : 'Enter their email address')
      return
    }
    setError(null)
    setFormError(null)
    invite.mutate(
      { email: value, role },
      {
        onSuccess: (inv) => {
          setCreated(inv)
          setEmail('')
          setRole('member')
        },
        onError: (err) => {
          const details = err instanceof ApiError ? err.details : undefined
          if (details?.email) setError(details.email === 'Already has an account' ? 'This person already has a LinkPilot account' : details.email)
          else setFormError(errorMessage(err))
        },
      },
    )
  }

  return (
    <Card className="p-5 sm:p-6">
      <h2 className="flex items-center gap-2 font-semibold">
        <UserPlus size={18} className="text-brand" aria-hidden /> Invite a teammate
      </h2>
      <p className="mt-1 text-sm text-ink-3">They get their own login, LinkedIn connection and campaigns.</p>
      <form onSubmit={submit} noValidate className="mt-5 space-y-4">
        <Field label="Email" error={error}>
          <Input
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              setError(null)
            }}
            placeholder="teammate@company.com"
            aria-invalid={!!error || undefined}
          />
        </Field>
        <Field label="Role" hint={role === 'admin' ? 'Admins can invite and remove members.' : 'Members run their own campaigns.'}>
          <Select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'member')}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </Select>
        </Field>
        {formError && <Alert tone="bad">{formError}</Alert>}
        <Button type="submit" className="w-full" loading={invite.isPending}>
          <Link2 size={16} aria-hidden /> Create invite link
        </Button>
      </form>
      {created && (
        <div className="mt-5 space-y-3 rounded-xl border border-ok/30 bg-ok/10 p-4">
          <p className="text-sm font-semibold">Invite link for {created.email}</p>
          <div className="flex gap-2">
            <Input readOnly value={inviteLink(created)} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" className="h-8 min-w-0 flex-1 font-mono text-xs" />
            <CopyButton text={inviteLink(created)} />
          </div>
          <p className="text-xs text-ink-2">LinkPilot doesn’t email invites – send this link to them yourself. It works once, for this email address.</p>
        </div>
      )}
    </Card>
  )
}

function PendingInvites({ invites }: { invites: TeamInvite[] }) {
  const revoke = useRevokeInvite()
  if (!invites.length) return null
  return (
    <Card className="p-5 sm:p-6">
      <h2 className="font-semibold">Pending invites</h2>
      <ul className="mt-2 divide-y divide-line">
        {invites.map((inv) => (
          <li key={inv.token} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{inv.email}</p>
              <p className="text-xs text-ink-3">
                {ROLE_LABEL[inv.role]} · invited {timeAgo(inv.createdAt)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <CopyButton text={inviteLink(inv)} label="Copy link" />
              <Button
                size="sm"
                variant="ghost"
                className="hover:text-bad"
                disabled={revoke.isPending && revoke.variables === inv.token}
                onClick={() =>
                  revoke.mutate(inv.token, {
                    onSuccess: () => toast(`Invite for ${inv.email} revoked`, 'success'),
                    onError: (err) => toast(errorMessage(err), 'error'),
                  })
                }
              >
                Revoke
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function MembersSkeleton() {
  return (
    <ul className="divide-y divide-line" aria-label="Loading members">
      {[0, 1, 2].map((i) => (
        <li key={i} className="flex items-center gap-3 py-4">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
        </li>
      ))}
    </ul>
  )
}

export default function Teams() {
  const { user } = useAuth()
  const team = useTeam()
  const remove = useRemoveMember()
  const [removing, setRemoving] = useState<TeamMember | null>(null)
  const isOwner = user?.role === 'owner'
  const canManage = isOwner || user?.role === 'admin'

  return (
    <>
      <PageHeader title="Teams" />
      <div className={cn('grid gap-6', canManage && 'lg:grid-cols-[minmax(0,1fr)_360px]')}>
        <div className="min-w-0 space-y-6">
          <Card className="p-5 sm:p-8">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                  <Users size={20} className="text-brand" aria-hidden />
                  {team.data?.workspaceName || 'Your workspace'}
                </h2>
                <p className="mt-1 text-sm text-ink-3">
                  Everyone connects their own LinkedIn account and runs their own campaigns – campaigns and leads are private to each member.
                </p>
              </div>
              {team.data && <Badge>{team.data.members.length} member{team.data.members.length === 1 ? '' : 's'}</Badge>}
            </div>
            <div className="mt-4">
              {team.data ? (
                <ul className="@container divide-y divide-line">
                  {team.data.members.map((m) => (
                    <MemberRow key={m.id} member={m} meId={user?.id ?? ''} isOwner={isOwner} canManage={canManage} onRemove={setRemoving} />
                  ))}
                </ul>
              ) : team.isError ? (
                <ErrorState title="Couldn’t load your team" message={errorMessage(team.error)} onRetry={() => void team.refetch()} className="mt-2" />
              ) : (
                <MembersSkeleton />
              )}
            </div>
            {!canManage && (
              <p className="mt-4 flex items-center gap-2 border-t border-line pt-4 text-sm text-ink-3">
                <ShieldCheck size={16} aria-hidden /> Only the workspace owner or an admin can invite or remove members.
              </p>
            )}
          </Card>
          {canManage && team.data && <PendingInvites invites={team.data.invites} />}
        </div>
        {canManage && (
          <div className="min-w-0 lg:order-none">
            <InviteForm />
          </div>
        )}
      </div>

      <ConfirmModal
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.name ?? 'member'}?`}
        body={
          <>
            <span className="font-medium text-ink">{removing?.email}</span> loses access immediately. Their campaigns, leads and LinkedIn session are deleted permanently.
          </>
        }
        confirmLabel="Remove member"
        onConfirm={() => {
          const m = removing
          if (!m) return
          remove.mutate(m.id, {
            onSuccess: () => toast(`${m.name} was removed from the team`, 'success'),
            onError: (err) => toast(errorMessage(err), 'error'),
          })
        }}
      />
    </>
  )
}
