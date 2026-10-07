import clsx, { type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// Teach tailwind-merge our custom color tokens so e.g. `text-ink` and `text-sm` don't collide.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      color: ['bg', 'sidebar', 'panel', 'panel-2', 'line', 'line-strong', 'ink', 'ink-2', 'ink-3', 'brand', 'brand-strong', 'brand-soft', 'ok', 'warn', 'bad', 'info', 'accent'],
    },
  },
})

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))

export const uid = (prefix = 'id') =>
  `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`

export const pct = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 100) : 0

export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function formatDateTime(iso: string) {
  const d = new Date(iso)
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${d
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    .toLowerCase()}`
}

export function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function defaultCampaignName() {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Fill {{variables}} with lead data for previews. */
export function renderTemplate(text: string, vars: Record<string, string>) {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`)
}

const LINKEDIN_PROFILE_RE = /^https?:\/\/(www\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+\/?(\?.*)?$/i

export function parseProfileUrls(raw: string) {
  const lines = raw.split(/[\n,\s]+/).map((l) => l.trim()).filter(Boolean)
  const valid: string[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  for (const l of lines) {
    if (LINKEDIN_PROFILE_RE.test(l)) {
      const norm = l.split('?')[0].replace(/\/?$/, '/').toLowerCase()
      if (!seen.has(norm)) {
        seen.add(norm)
        valid.push(l)
      }
    } else invalid.push(l)
  }
  return { valid, invalid }
}

/** Derive a readable name from a LinkedIn slug like "mike-johnson-1918171691". */
export function nameFromProfileUrl(url: string) {
  const slug = url.split('/in/')[1]?.split(/[/?]/)[0] ?? 'linkedin-member'
  const parts = decodeURIComponent(slug)
    .split('-')
    .filter((p) => p && !/^\d+$/.test(p) && !/^[0-9a-f]{6,}$/i.test(p))
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  return {
    firstName: cap(parts[0] ?? 'LinkedIn'),
    lastName: parts.slice(1).map(cap).join(' ') || 'Member',
  }
}

export const isValidSearchUrl = (url: string, kind: 'search' | 'sales_nav') =>
  kind === 'search'
    ? /^https?:\/\/(www\.)?linkedin\.com\/search\/results\/people/i.test(url.trim())
    : /^https?:\/\/(www\.)?linkedin\.com\/sales\/(search|lists)/i.test(url.trim())
