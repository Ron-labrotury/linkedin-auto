import type {
  Activity,
  Campaign,
  CampaignSettings,
  Conversation,
  Lead,
  LeadStatus,
  LinkedInAccount,
  TeamMember,
} from '../types'
import { SEQUENCE_TEMPLATES } from '../lib/sequence'

const FIRST = ['Jagadish', 'John', 'Hemkumar', 'Priya', 'Rahul', 'Ananya', 'Vikram', 'Sneha', 'Arjun', 'Meera', 'Karan', 'Neha', 'Rohan', 'Isha', 'Aditya', 'Kavya', 'Sanjay', 'Divya', 'Nikhil', 'Pooja', 'Rajesh', 'Shreya', 'Amit', 'Tanvi']
const LAST = ['Ramasamy', 'D’Almeida', 'Dhanasekaran', 'Sharma', 'Mehta', 'Iyer', 'Kulkarni', 'Nair', 'Reddy', 'Patil', 'Gupta', 'Desai', 'Joshi', 'Menon', 'Rao', 'Kapoor']
const TITLES = ['VP Engineering', 'Head of Sales', 'CTO', 'Founder & CEO', 'Director of Operations', 'Engineering Manager', 'Procurement Lead', 'Head of Marketing', 'Plant Manager', 'IT Director']
const COMPANIES = ['Honeywell', 'Infosys', 'Tata Motors', 'Zoho', 'Freshworks', 'Bajaj Auto', 'Mahindra', 'Wipro', 'Persistent', 'L&T Technology', 'Thermax', 'KPIT']
const CITIES = ['Pune, India', 'Bengaluru, India', 'Mumbai, India', 'Chennai, India', 'Hyderabad, India', 'Gurugram, India']

// Small deterministic PRNG so the demo looks the same on every load.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
}
const rand = rng(42)
const pick = <T,>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)]

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()

export const DEFAULT_SETTINGS: CampaignSettings = {
  dailyInvites: 28,
  dailyMessages: 28,
  dailyProfileViews: 20,
  dailyEmails: 20,
  workingDays: [1, 2, 3, 4, 5],
  startHour: 9,
  endHour: 18,
  timezone: 'Asia/Kolkata',
  skipConnected: true,
  skipOtherCampaigns: true,
  stopOnReply: true,
}

function makeLead(i: number, campaignId: string | undefined, listName: string, status: LeadStatus): Lead {
  const firstName = FIRST[i % FIRST.length]
  const lastName = pick(LAST)
  const slug = `${firstName}-${lastName}`.toLowerCase().replace(/[^a-z-]/g, '')
  const company = pick(COMPANIES)
  return {
    id: `lead_${i}`,
    firstName,
    lastName,
    headline: `${pick(TITLES)} at ${company}`,
    company,
    location: pick(CITIES),
    profileUrl: `https://www.linkedin.com/in/${slug}-${1000 + i}/`,
    email: rand() > 0.5 ? `${firstName.toLowerCase()}@${company.toLowerCase().replace(/[^a-z]/g, '')}.com` : undefined,
    status,
    campaignId,
    listName,
    lastAction: status === 'queued' ? undefined : status === 'invited' ? 'Invite sent' : status === 'connected' ? 'Invite accepted' : status === 'replied' ? 'Replied' : 'Profile viewed',
    lastActionAt: status === 'queued' ? undefined : hoursAgo(Math.floor(rand() * 72)),
    tags: rand() > 0.7 ? ['hot'] : [],
  }
}

const statusPool: LeadStatus[] = ['invited', 'invited', 'invited', 'connected', 'replied', 'in_progress', 'queued', 'queued', 'queued', 'queued']

export const MOCK_LEADS: Lead[] = [
  ...Array.from({ length: 23 }, (_, i) => makeLead(i, 'cmp_last23', 'last 23', i < 3 ? 'invited' : 'queued')),
  ...Array.from({ length: 40 }, (_, i) => makeLead(100 + i, 'cmp_pune_mfg', 'Pune manufacturing heads', statusPool[i % statusPool.length])),
  ...Array.from({ length: 12 }, (_, i) => makeLead(200 + i, undefined, 'Unassigned import', 'queued')),
]

const idsFor = (cid: string) => MOCK_LEADS.filter((l) => l.campaignId === cid).map((l) => l.id)

export const MOCK_CAMPAIGNS: Campaign[] = [
  {
    id: 'cmp_last23',
    name: 'last 23',
    status: 'active',
    createdAt: hoursAgo(1),
    leadIds: idsFor('cmp_last23'),
    contacted: 3,
    sequence: SEQUENCE_TEMPLATES[1].build(),
    settings: DEFAULT_SETTINGS,
    stats: { invitesSent: 3, accepted: 0, messagesSent: 0, replied: 0, emailsSent: 0, emailsReplied: 0, profileViews: 3 },
  },
  {
    id: 'cmp_pune_mfg',
    name: 'Pune manufacturing heads',
    status: 'paused',
    createdAt: hoursAgo(24 * 6),
    leadIds: idsFor('cmp_pune_mfg'),
    contacted: 28,
    sequence: SEQUENCE_TEMPLATES[3].build(),
    settings: { ...DEFAULT_SETTINGS, dailyInvites: 20 },
    stats: { invitesSent: 28, accepted: 8, messagesSent: 8, replied: 4, emailsSent: 6, emailsReplied: 1, profileViews: 32 },
  },
]

export const MOCK_ACTIVITY: Activity[] = [
  { id: 'a1', type: 'invite', leadName: 'Jagadish Kumar Ramasamy', campaignId: 'cmp_last23', campaignName: 'last 23', at: hoursAgo(0.05) },
  { id: 'a2', type: 'invite', leadName: 'John Shelvin D’Almeida', campaignId: 'cmp_last23', campaignName: 'last 23', at: hoursAgo(0.1) },
  { id: 'a3', type: 'invite', leadName: 'Hemkumar Dhanasekaran', campaignId: 'cmp_last23', campaignName: 'last 23', at: hoursAgo(0.15) },
  { id: 'a4', type: 'view', leadName: 'Hemkumar Dhanasekaran', campaignId: 'cmp_last23', campaignName: 'last 23', at: hoursAgo(0.3) },
  { id: 'a5', type: 'reply', leadName: 'Priya Sharma', campaignId: 'cmp_pune_mfg', campaignName: 'Pune manufacturing heads', at: hoursAgo(20) },
  { id: 'a6', type: 'accepted', leadName: 'Vikram Kulkarni', campaignId: 'cmp_pune_mfg', campaignName: 'Pune manufacturing heads', at: hoursAgo(26) },
  { id: 'a7', type: 'message', leadName: 'Vikram Kulkarni', campaignId: 'cmp_pune_mfg', campaignName: 'Pune manufacturing heads', at: hoursAgo(25) },
  { id: 'a8', type: 'email', leadName: 'Neha Desai', campaignId: 'cmp_pune_mfg', campaignName: 'Pune manufacturing heads', at: hoursAgo(30) },
]

export const MOCK_CONVERSATIONS: Conversation[] = [
  {
    id: 'c1',
    leadId: 'lead_103',
    name: 'Priya Sharma',
    headline: 'Head of Sales at Thermax',
    unread: true,
    campaignName: 'Pune manufacturing heads',
    messages: [
      { id: 'm1', from: 'me', text: 'Thanks for connecting, Priya! I work with manufacturing teams in Pune on automating lead qualification. Open to a quick chat?', at: hoursAgo(44) },
      { id: 'm2', from: 'them', text: 'Hi, sure. Can you share some details over email first?', at: hoursAgo(20) },
    ],
  },
  {
    id: 'c2',
    leadId: 'lead_104',
    name: 'Vikram Kulkarni',
    headline: 'Plant Manager at Bajaj Auto',
    unread: false,
    campaignName: 'Pune manufacturing heads',
    messages: [
      { id: 'm3', from: 'me', text: 'Thanks for connecting, Vikram!', at: hoursAgo(25) },
    ],
  },
  {
    id: 'c3',
    leadId: 'lead_114',
    name: 'Rohan Joshi',
    headline: 'CTO at KPIT',
    unread: false,
    messages: [
      { id: 'm4', from: 'them', text: 'Hey, saw your post on CRM automation – interesting stuff.', at: hoursAgo(80) },
      { id: 'm5', from: 'me', text: 'Thanks Rohan! Happy to share the playbook we used.', at: hoursAgo(78) },
    ],
  },
]

export const MOCK_TEAM: TeamMember[] = [
  { id: 't1', name: 'Prajakta T.', email: 'prajakta@example.com', role: 'Owner', linkedinConnected: true, activeCampaigns: 1, invitedAt: hoursAgo(24 * 30) },
  { id: 't2', name: 'Ronak K.', email: 'ronak@example.com', role: 'Admin', linkedinConnected: false, activeCampaigns: 0, invitedAt: hoursAgo(24 * 3) },
]

export const MOCK_ACCOUNT: LinkedInAccount = {
  name: 'Prajakta T.',
  headline: 'Business Development at Pratiti Technologies',
  connected: true,
  plan: 'Free',
}

export const MOCK_PENDING_INVITES = 723
export const MOCK_PROFILE_VIEWS_DELTA = 19

/** Demo-only: stand-in leads for search/Sales Navigator imports until the backend scraper exists. */
export function generateSampleLeads(count: number, listName: string): Lead[] {
  const seed = Date.now() % 100000
  return Array.from({ length: count }, (_, i) => {
    const l = makeLead(seed + i, undefined, listName, 'queued')
    return { ...l, id: `lead_${seed}_${i}_${Math.random().toString(36).slice(2, 6)}` }
  })
}
