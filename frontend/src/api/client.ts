/**
 * Typed client for the backend API (see docs/API.md). Every function maps 1:1 to an endpoint.
 * The session token is kept in localStorage and sent as a Bearer token, so the frontend can be
 * hosted on a different origin (e.g. Vercel) than the API.
 */
import type {
  Activity,
  AddLeadsInput,
  AddLeadsResponse,
  ApiError as ApiErrorBody,
  AuthResponse,
  Campaign,
  CampaignSummary,
  CreateCampaignInput,
  Dashboard,
  LeadStatus,
  LeadsPage,
  LinkedInAccount,
  LinkedInConnectResponse,
  LinkedInTestResponse,
  Role,
  Team,
  TeamInvite,
  TeamMember,
  UpdateCampaignInput,
  User,
  UserSettings,
} from '@shared/types.ts'

/** e.g. "https://api.example.com" (no trailing slash). Empty = same origin (dev proxy / single deploy). */
// (`?.` only so the module also loads in plain Node for tests, where import.meta.env doesn't exist)
export const API_URL = ((import.meta.env?.VITE_API_URL as string | undefined) ?? '').replace(/\/$/, '')

/** Where API calls go, for error messages: "https://api.example.com/api". */
const apiBase = () => `${API_URL || (typeof window === 'undefined' ? '' : window.location.origin)}/api`

/** Shown when /api answers with something that isn't the API (e.g. the frontend's index.html). */
export const apiUnreachableMessage = (base: string) => `The API isn’t reachable at ${base} – set VITE_API_URL to your backend URL`

const TOKEN_KEY = 'linkpilot.token'

export const tokenStore = {
  get(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY)
    } catch {
      return null
    }
  },
  set(token: string | null) {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token)
      else localStorage.removeItem(TOKEN_KEY)
    } catch {
      /* storage unavailable – session lasts for this page only */
    }
  },
}

export class ApiError extends Error {
  readonly status: number
  readonly details?: Record<string, string>
  constructor(status: number, message: string, details?: Record<string, string>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.details = details
  }
}

/** Fired when the API answers 401 – the app listens and sends the user to /login. */
export const UNAUTHORIZED_EVENT = 'linkpilot:unauthorized'

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = tokenStore.get()
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let res: Response
  try {
    res = await fetch(`${API_URL}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch {
    throw new ApiError(0, 'Can’t reach the server. Check your connection and try again.')
  }

  if (res.status === 204) return undefined as T
  // The API always answers JSON. Anything else means the request reached something else – typically a
  // static host serving index.html for /api/* because VITE_API_URL isn't set (Vercel answers 200 for
  // GET and 405 for POST). Fail clearly instead of handing `null` to the app (an endless spinner).
  const isJson = /\bjson\b/i.test(res.headers.get('content-type') ?? '')
  const data = isJson ? ((await res.json().catch(() => undefined)) as unknown) : undefined
  if (data === undefined && (res.ok || res.status === 404 || res.status === 405)) throw new ApiError(0, apiUnreachableMessage(apiBase()))
  if (!res.ok) {
    const err = (data ?? {}) as Partial<ApiErrorBody>
    if (res.status === 401 && token) {
      tokenStore.set(null)
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
    }
    throw new ApiError(res.status, err.error ?? `Request failed (${res.status})`, err.details)
  }
  return data as T
}

const qs = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, String(v))
  const str = s.toString()
  return str ? `?${str}` : ''
}

export const api = {
  health: () => request<{ ok: boolean; driver: 'playwright' | 'simulated' }>('GET', '/health'),

  // auth
  signup: (body: { name: string; email: string; password: string; inviteToken?: string }) => request<AuthResponse>('POST', '/auth/signup', body),
  login: (body: { email: string; password: string }) => request<AuthResponse>('POST', '/auth/login', body),
  logout: () => request<void>('POST', '/auth/logout'),
  me: () => request<User>('GET', '/auth/me'),
  updateMe: (body: { name: string }) => request<User>('PATCH', '/auth/me', body),
  changePassword: (body: { currentPassword: string; newPassword: string }) => request<void>('POST', '/auth/password', body),
  getInvite: (token: string) => request<{ email: string; workspaceName: string; role: Role }>('GET', `/auth/invite/${encodeURIComponent(token)}`),

  // settings
  getSettings: () => request<UserSettings>('GET', '/settings'),
  updateSettings: (body: UserSettings) => request<UserSettings>('PUT', '/settings', body),

  // linkedin
  getLinkedIn: () => request<LinkedInAccount>('GET', '/linkedin'),
  linkedinLogin: (body: { email: string; password: string }) => request<LinkedInConnectResponse>('POST', '/linkedin/login', body),
  linkedinVerify: (body: { code: string }) => request<LinkedInConnectResponse>('POST', '/linkedin/verify', body),
  linkedinCheck: () => request<LinkedInConnectResponse>('POST', '/linkedin/check'),
  linkedinCookie: (body: { liAt: string }) => request<LinkedInConnectResponse>('POST', '/linkedin/cookie', body),
  linkedinTest: () => request<LinkedInTestResponse>('POST', '/linkedin/test'),
  linkedinDisconnect: () => request<void>('DELETE', '/linkedin'),

  // campaigns
  listCampaigns: () => request<CampaignSummary[]>('GET', '/campaigns'),
  createCampaign: (body: CreateCampaignInput) => request<Campaign>('POST', '/campaigns', body),
  getCampaign: (id: string) => request<Campaign>('GET', `/campaigns/${id}`),
  updateCampaign: (id: string, body: UpdateCampaignInput) => request<Campaign>('PATCH', `/campaigns/${id}`, body),
  deleteCampaign: (id: string) => request<void>('DELETE', `/campaigns/${id}`),
  listLeads: (id: string, params: { status?: LeadStatus; q?: string; offset?: number; limit?: number } = {}) =>
    request<LeadsPage>('GET', `/campaigns/${id}/leads${qs(params)}`),
  addLeads: (id: string, body: AddLeadsInput) => request<AddLeadsResponse>('POST', `/campaigns/${id}/leads`, body),
  deleteLeads: (id: string, ids: string[]) => request<void>('DELETE', `/campaigns/${id}/leads`, { ids }),
  campaignActivity: (id: string, limit = 100) => request<Activity[]>('GET', `/campaigns/${id}/activity${qs({ limit })}`),

  // dashboard
  dashboard: () => request<Dashboard>('GET', '/dashboard'),

  // team
  getTeam: () => request<Team>('GET', '/team'),
  inviteMember: (body: { email: string; role: 'admin' | 'member' }) => request<TeamInvite>('POST', '/team/invites', body),
  revokeInvite: (token: string) => request<void>('DELETE', `/team/invites/${encodeURIComponent(token)}`),
  updateMember: (id: string, body: { role: 'admin' | 'member' }) => request<TeamMember>('PATCH', `/team/members/${id}`, body),
  removeMember: (id: string) => request<void>('DELETE', `/team/members/${id}`),
}

/** React Query keys – invalidate these after mutations. */
export const qk = {
  me: ['me'] as const,
  settings: ['settings'] as const,
  linkedin: ['linkedin'] as const,
  dashboard: ['dashboard'] as const,
  campaigns: ['campaigns'] as const,
  campaign: (id: string) => ['campaigns', id] as const,
  leads: (id: string, params?: object) => ['campaigns', id, 'leads', params ?? {}] as const,
  activity: (id: string) => ['campaigns', id, 'activity'] as const,
  team: ['team'] as const,
}

/** Message to show for any thrown error. */
export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong')
