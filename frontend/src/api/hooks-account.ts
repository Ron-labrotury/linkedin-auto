/** React Query hooks for the signed-in user, LinkedIn account, settings and team. */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { LinkedInAccount, LinkedInConnectResponse, LinkedInTestResponse, Team, User, UserSettings } from '@shared/types.ts'
import { ApiError, api, qk } from './client'

const isAuthError = (e: unknown) => e instanceof ApiError && (e.status === 401 || e.status === 403)

/* ------------------------------ user ------------------------------ */

export function useMe(enabled = true) {
  return useQuery({
    queryKey: qk.me,
    queryFn: api.me,
    enabled,
    staleTime: 5 * 60_000,
    retry: (count, e) => !isAuthError(e) && count < 1,
  })
}

export function useUpdateMe() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => api.updateMe({ name }),
    onSuccess: (user) => {
      qc.setQueryData<User>(qk.me, user)
      void qc.invalidateQueries({ queryKey: qk.team })
    },
  })
}

export function useChangePassword() {
  return useMutation({ mutationFn: api.changePassword })
}

/* ---------------------------- settings ---------------------------- */

export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: api.getSettings })
}

export function useUpdateSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (s: UserSettings) => api.updateSettings(s),
    onSuccess: (s) => {
      qc.setQueryData<UserSettings>(qk.settings, s)
      void qc.invalidateQueries({ queryKey: qk.dashboard })
    },
  })
}

/* ---------------------------- linkedin ---------------------------- */

export function useLinkedIn(opts: { refetchInterval?: number | false } = {}) {
  return useQuery({ queryKey: qk.linkedin, queryFn: api.getLinkedIn, refetchInterval: opts.refetchInterval })
}

/** Store a fresh account from a LinkedIn response; refresh everything that shows it when the status changed. */
export function applyLinkedInAccount(qc: QueryClient, account: LinkedInAccount, opts: { force?: boolean } = {}) {
  const prev = qc.getQueryData<LinkedInAccount>(qk.linkedin)
  qc.setQueryData<LinkedInAccount>(qk.linkedin, account)
  if (opts.force || prev?.status !== account.status) invalidateLinkedIn(qc)
}

export function invalidateLinkedIn(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: qk.linkedin })
  void qc.invalidateQueries({ queryKey: qk.dashboard })
  void qc.invalidateQueries({ queryKey: qk.team })
}

function useLinkedInMutation<V, R extends LinkedInConnectResponse | LinkedInTestResponse>(fn: (v: V) => Promise<R>, opts: { force?: boolean } = {}) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (res) => applyLinkedInAccount(qc, res.account, opts),
    // a failed call may still have changed the stored status (e.g. to "error")
    onError: () => invalidateLinkedIn(qc),
  })
}

export const useLinkedInLogin = () => useLinkedInMutation((v: { email: string; password: string }) => api.linkedinLogin(v), { force: true })
export const useLinkedInVerify = () => useLinkedInMutation((code: string) => api.linkedinVerify({ code }), { force: true })
export const useLinkedInCheck = () => useLinkedInMutation(() => api.linkedinCheck())
export const useLinkedInCookie = () => useLinkedInMutation((liAt: string) => api.linkedinCookie({ liAt }), { force: true })
export const useLinkedInTest = () => useLinkedInMutation(() => api.linkedinTest(), { force: true })

export function useLinkedInDisconnect() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.linkedinDisconnect,
    onSuccess: () => {
      qc.setQueryData<LinkedInAccount>(qk.linkedin, (prev) => ({
        status: 'disconnected',
        authMethod: null,
        email: prev?.email ?? null,
        profile: null,
        lastCheckedAt: null,
        lastError: null,
      }))
    },
    onSettled: () => invalidateLinkedIn(qc),
  })
}

/* ---------------------------- campaigns --------------------------- */

/** Campaign summaries (same key/fn as the campaigns pages, so the cache is shared). */
export function useCampaignSummaries() {
  return useQuery({ queryKey: qk.campaigns, queryFn: api.listCampaigns })
}

/* ------------------------------ team ------------------------------ */

export function useTeam() {
  return useQuery({ queryKey: qk.team, queryFn: api.getTeam })
}

function useTeamMutation<V, R>(fn: (v: V) => Promise<R>, update?: (team: Team, v: V, r: R) => Team) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (r, v) => {
      if (update) qc.setQueryData<Team>(qk.team, (t) => (t ? update(t, v, r) : t))
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.team }),
  })
}

export const useInviteMember = () =>
  useTeamMutation(api.inviteMember, (t, _v, invite) => ({ ...t, invites: [invite, ...t.invites.filter((i) => i.email !== invite.email)] }))

export const useRevokeInvite = () => useTeamMutation(api.revokeInvite, (t, token) => ({ ...t, invites: t.invites.filter((i) => i.token !== token) }))

export const useUpdateMember = () =>
  useTeamMutation(
    (v: { id: string; role: 'admin' | 'member' }) => api.updateMember(v.id, { role: v.role }),
    (t, _v, member) => ({ ...t, members: t.members.map((m) => (m.id === member.id ? member : m)) }),
  )

export const useRemoveMember = () => useTeamMutation(api.removeMember, (t, id) => ({ ...t, members: t.members.filter((m) => m.id !== id) }))
