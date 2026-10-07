import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Campaign, ChatMessage, Conversation, Lead, LinkedInAccount, TeamMember, Activity } from '../types'
import {
  MOCK_ACCOUNT,
  MOCK_ACTIVITY,
  MOCK_CAMPAIGNS,
  MOCK_CONVERSATIONS,
  MOCK_LEADS,
  MOCK_PENDING_INVITES,
  MOCK_TEAM,
} from '../data/mock'
import { uid } from '../lib/utils'

/**
 * Client-side store backed by localStorage. Every mutation here maps to a
 * future backend endpoint; swap the bodies for API calls when the backend lands.
 */
interface AppState {
  account: LinkedInAccount
  campaigns: Campaign[]
  leads: Lead[]
  activity: Activity[]
  conversations: Conversation[]
  team: TeamMember[]
  pendingInvites: number

  createCampaign: (c: Omit<Campaign, 'id' | 'createdAt' | 'contacted' | 'stats' | 'leadIds'>, leads: Lead[]) => string
  updateCampaign: (id: string, patch: Partial<Campaign>) => void
  deleteCampaign: (id: string) => void
  toggleCampaign: (id: string) => void

  addLeads: (leads: Lead[]) => void
  deleteLeads: (ids: string[]) => void

  withdrawInvites: (count: number) => void

  sendMessage: (conversationId: string, text: string) => void
  markRead: (conversationId: string) => void

  inviteMember: (name: string, email: string, role: TeamMember['role']) => void
  removeMember: (id: string) => void

  updateAccount: (patch: Partial<LinkedInAccount>) => void
  resetDemo: () => void
}

const initial = () => ({
  account: MOCK_ACCOUNT,
  campaigns: MOCK_CAMPAIGNS,
  leads: MOCK_LEADS,
  activity: MOCK_ACTIVITY,
  conversations: MOCK_CONVERSATIONS,
  team: MOCK_TEAM,
  pendingInvites: MOCK_PENDING_INVITES,
})

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      ...initial(),

      createCampaign: (c, leads) => {
        const id = uid('cmp')
        const tagged = leads.map((l) => ({ ...l, campaignId: id }))
        const campaign: Campaign = {
          ...c,
          id,
          createdAt: new Date().toISOString(),
          contacted: 0,
          leadIds: tagged.map((l) => l.id),
          stats: { invitesSent: 0, accepted: 0, messagesSent: 0, replied: 0, emailsSent: 0, emailsReplied: 0, profileViews: 0 },
        }
        set((s) => {
          const existing = new Set(s.leads.map((l) => l.id))
          return {
            campaigns: [campaign, ...s.campaigns],
            leads: [...s.leads.map((l) => tagged.find((t) => t.id === l.id) ?? l), ...tagged.filter((t) => !existing.has(t.id))],
          }
        })
        return id
      },

      updateCampaign: (id, patch) =>
        set((s) => ({ campaigns: s.campaigns.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),

      deleteCampaign: (id) =>
        set((s) => ({
          campaigns: s.campaigns.filter((c) => c.id !== id),
          leads: s.leads.map((l) => (l.campaignId === id ? { ...l, campaignId: undefined } : l)),
        })),

      toggleCampaign: (id) =>
        set((s) => ({
          campaigns: s.campaigns.map((c) =>
            c.id === id ? { ...c, status: c.status === 'active' ? 'paused' : 'active' } : c,
          ),
        })),

      addLeads: (leads) => set((s) => ({ leads: [...leads, ...s.leads] })),

      deleteLeads: (ids) => {
        const del = new Set(ids)
        set((s) => ({
          leads: s.leads.filter((l) => !del.has(l.id)),
          campaigns: s.campaigns.map((c) => ({ ...c, leadIds: c.leadIds.filter((id) => !del.has(id)) })),
        }))
      },

      withdrawInvites: (count) => set((s) => ({ pendingInvites: Math.max(0, s.pendingInvites - count) })),

      sendMessage: (conversationId, text) => {
        const msg: ChatMessage = { id: uid('msg'), from: 'me', text, at: new Date().toISOString() }
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === conversationId ? { ...c, messages: [...c.messages, msg] } : c,
          ),
        }))
      },

      markRead: (conversationId) =>
        set((s) => ({
          conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, unread: false } : c)),
        })),

      inviteMember: (name, email, role) =>
        set((s) => ({
          team: [
            ...s.team,
            { id: uid('tm'), name, email, role, linkedinConnected: false, activeCampaigns: 0, invitedAt: new Date().toISOString() },
          ],
        })),

      removeMember: (id) => set((s) => ({ team: s.team.filter((m) => m.id !== id) })),

      updateAccount: (patch) => set((s) => ({ account: { ...s.account, ...patch } })),

      resetDemo: () => set(initial()),
    }),
    { name: 'linkpilot-store', version: 1 },
  ),
)

/* ---------- Toasts (not persisted) ---------- */

export interface Toast {
  id: string
  message: string
  tone: 'info' | 'success' | 'error'
}

interface ToastState {
  toasts: Toast[]
  push: (message: string, tone?: Toast['tone']) => void
  dismiss: (id: string) => void
}

export const useToasts = create<ToastState>()((set, get) => ({
  toasts: [],
  push: (message, tone = 'info') => {
    const id = uid('toast')
    set((s) => ({ toasts: [...s.toasts, { id, message, tone }] }))
    setTimeout(() => get().dismiss(id), 4000)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

export const toast = (message: string, tone?: Toast['tone']) => useToasts.getState().push(message, tone)
