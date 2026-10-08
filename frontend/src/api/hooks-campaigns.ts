/** React Query hooks for campaigns, leads, activity and the dashboard. */
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type {
  AddLeadsInput,
  Campaign,
  CampaignSummary,
  CreateCampaignInput,
  Dashboard,
  LeadStatus,
  UpdateCampaignInput,
} from '@shared/types.ts'
import { ApiError, api, qk } from './client'

const notFound = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 401)
const retry = (count: number, e: unknown) => !notFound(e) && count < 2

export const toSummary = (c: Campaign): CampaignSummary => ({
  id: c.id,
  name: c.name,
  status: c.status,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
  stats: c.stats,
  stepCount: c.stepCount,
  pendingImports: c.pendingImports,
})

/** Apply `fn` to the summary of campaign `id` wherever summaries are cached (list + dashboard). */
function patchSummaries(qc: QueryClient, id: string, fn: (s: CampaignSummary) => CampaignSummary) {
  qc.setQueryData<CampaignSummary[]>(qk.campaigns, (list) => list?.map((x) => (x.id === id ? fn(x) : x)))
  qc.setQueryData<Dashboard>(qk.dashboard, (d) => (d ? { ...d, campaigns: d.campaigns.map((x) => (x.id === id ? fn(x) : x)) } : d))
}

/** Put a fresh campaign into the detail cache and the summary caches. */
function storeCampaign(qc: QueryClient, c: Campaign) {
  qc.setQueryData<Campaign>(qk.campaign(c.id), c)
  patchSummaries(qc, c.id, () => toSummary(c))
}

/** Refresh the list, the dashboard and everything under one campaign (leads, activity …). */
function refreshCampaign(qc: QueryClient, id?: string) {
  void qc.invalidateQueries({ queryKey: qk.campaigns, exact: true })
  void qc.invalidateQueries({ queryKey: qk.dashboard })
  if (id) void qc.invalidateQueries({ queryKey: qk.campaign(id) })
}

/**
 * Drop everything cached under a deleted campaign (detail, leads, activity), so going back to its
 * page asks the server (404 → "Campaign not found") instead of showing it as if it still existed.
 */
export function forgetCampaign(qc: QueryClient, id: string) {
  void qc.cancelQueries({ queryKey: qk.campaign(id) })
  qc.removeQueries({ queryKey: qk.campaign(id) })
}

/* ------------------------------ queries ------------------------------ */

/** The LinkedIn account (same key as the account hooks, so the cache is shared). */
export function useLinkedInAccount() {
  return useQuery({ queryKey: qk.linkedin, queryFn: api.getLinkedIn, staleTime: 30_000 })
}

export function useDashboard() {
  return useQuery({ queryKey: qk.dashboard, queryFn: api.dashboard, refetchInterval: 15_000 })
}

export function useCampaigns() {
  return useQuery({ queryKey: qk.campaigns, queryFn: api.listCampaigns, refetchInterval: 15_000 })
}

/** One campaign; refreshes every 10 s while it is running (and still exists). */
export function useCampaign(id: string) {
  return useQuery({
    queryKey: qk.campaign(id),
    queryFn: () => api.getCampaign(id),
    retry,
    refetchInterval: (q) => (q.state.data?.status === 'active' && !notFound(q.state.error) ? 10_000 : false),
  })
}

export interface LeadsParams {
  status?: LeadStatus
  q?: string
  offset: number
  limit: number
}

export function useLeads(id: string, params: LeadsParams, opts: { live: boolean }) {
  return useQuery({
    queryKey: qk.leads(id, params),
    queryFn: () => api.listLeads(id, params),
    placeholderData: keepPreviousData,
    retry,
    refetchInterval: opts.live ? 10_000 : false,
  })
}

export function useActivity(id: string, limit = 100) {
  return useQuery({
    queryKey: qk.activity(id),
    queryFn: () => api.campaignActivity(id, limit),
    retry,
    refetchInterval: 10_000,
  })
}

/* ----------------------------- mutations ----------------------------- */

export function useCreateCampaign() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateCampaignInput) => api.createCampaign(input),
    onSuccess: (c) => {
      qc.setQueryData<Campaign>(qk.campaign(c.id), c)
      qc.setQueryData<CampaignSummary[]>(qk.campaigns, (list) => (list ? [toSummary(c), ...list.filter((x) => x.id !== c.id)] : list))
      refreshCampaign(qc)
    },
  })
}

type Snapshot = { list?: CampaignSummary[]; detail?: Campaign; dashboard?: Dashboard }

/**
 * PATCH a campaign. Status and name changes show immediately (rolled back if the server refuses);
 * sequence and settings changes wait for the server.
 */
export function useUpdateCampaign() {
  const qc = useQueryClient()
  return useMutation<Campaign, Error, { id: string; patch: UpdateCampaignInput }, Snapshot>({
    mutationFn: ({ id, patch }) => api.updateCampaign(id, patch),
    onMutate: async ({ id, patch }) => {
      const quick: Partial<CampaignSummary> = {}
      if (patch.status) quick.status = patch.status
      if (patch.name !== undefined) quick.name = patch.name
      if (!Object.keys(quick).length) return {}
      await Promise.all([
        qc.cancelQueries({ queryKey: qk.campaigns, exact: true }),
        qc.cancelQueries({ queryKey: qk.campaign(id), exact: true }),
        qc.cancelQueries({ queryKey: qk.dashboard }),
      ])
      const snap: Snapshot = { list: qc.getQueryData(qk.campaigns), detail: qc.getQueryData(qk.campaign(id)), dashboard: qc.getQueryData(qk.dashboard) }
      patchSummaries(qc, id, (x) => ({ ...x, ...quick }))
      qc.setQueryData<Campaign>(qk.campaign(id), (c) => (c ? { ...c, ...quick } : c))
      return snap
    },
    onError: (_e, { id }, snap) => {
      if (snap?.list) qc.setQueryData(qk.campaigns, snap.list)
      if (snap?.detail) qc.setQueryData(qk.campaign(id), snap.detail)
      if (snap?.dashboard) qc.setQueryData(qk.dashboard, snap.dashboard)
    },
    onSuccess: (c) => storeCampaign(qc, c),
    onSettled: (_c, _e, { id }) => refreshCampaign(qc, id),
  })
}

export function useDeleteCampaign() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteCampaign(id),
    onSuccess: (_r, id) => {
      forgetCampaign(qc, id)
      qc.setQueryData<CampaignSummary[]>(qk.campaigns, (list) => list?.filter((x) => x.id !== id))
      qc.setQueryData<Dashboard>(qk.dashboard, (d) => (d ? { ...d, campaigns: d.campaigns.filter((x) => x.id !== id) } : d))
      void qc.invalidateQueries({ queryKey: qk.campaigns, exact: true })
      void qc.invalidateQueries({ queryKey: qk.dashboard })
    },
  })
}

export function useAddLeads(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: AddLeadsInput) => api.addLeads(id, input),
    onSuccess: () => refreshCampaign(qc, id),
  })
}

export function useDeleteLeads(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) => api.deleteLeads(id, ids),
    onSettled: () => refreshCampaign(qc, id),
  })
}
