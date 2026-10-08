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

/** "3 leads", "1 lead" */
export const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? word : many}`

export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase()
}

export function formatDateTime(iso: string) {
  const d = new Date(iso)
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${formatTime(iso)}`
}

export function timeAgo(iso: string, now = Date.now()) {
  const s = Math.floor((now - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** "due now", "in 3 min", "in 2 h", "in 4 d" for a future instant. */
export function timeUntil(iso: string, now = Date.now()) {
  const s = Math.round((new Date(iso).getTime() - now) / 1000)
  if (s < 30) return 'due now'
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))} min`
  if (s < 86400) return `in ${Math.round(s / 3600)} h`
  return `in ${Math.round(s / 86400)} d`
}

/** "at 9:00 am" today, "tomorrow at 9:00 am", otherwise "Mon, Oct 12 at 9:00 am" (viewer's local time). */
export function formatWhen(iso: string, now = Date.now()) {
  const d = new Date(iso)
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(d) - day(new Date(now))) / 86_400_000)
  const time = formatTime(iso)
  if (diff === 0) return `at ${time}`
  if (diff === 1) return `tomorrow at ${time}`
  return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} at ${time}`
}

export function defaultCampaignName(date = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `Campaign ${p(date.getDate())}.${p(date.getMonth() + 1)}.${date.getFullYear()} ${p(date.getHours())}:${p(date.getMinutes())}`
}

/** Structural equality for plain JSON data (sequences, settings), independent of key order. */
export function jsonEqual(a: unknown, b: unknown) {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
              .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
          )
        : v
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b))
}
