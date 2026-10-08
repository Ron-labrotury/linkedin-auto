import { AlertCircle, CheckCircle2, Clock, LoaderCircle, Search } from 'lucide-react'
import type { Campaign, ImportStatus, LeadImport } from '@shared/types.ts'
import { cn, formatDateTime, pct, plural } from '../../../lib/utils'
import { Badge, type BadgeTone } from '../../../components/ui'

export function StatsFunnel({ c }: { c: Campaign }) {
  const s = c.stats
  const items: { label: string; value: number; note?: string; tone?: string }[] = [
    { label: 'Profile views', value: s.profileViews },
    { label: 'Invites sent', value: s.invitesSent },
    { label: 'Accepted', value: s.accepted, note: `${pct(s.accepted, s.invitesSent)}% of invites` },
    { label: 'Messages sent', value: s.messagesSent },
    { label: 'Replied', value: s.replied, note: `${pct(s.replied, s.contacted)}% of contacted` },
    { label: 'Failed', value: s.failed, note: s.failed ? 'leads with errors' : undefined, tone: s.failed ? 'text-bad' : undefined },
  ]
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3 xl:grid-cols-6">
      {items.map((i) => (
        <div key={i.label} className="bg-panel p-4 sm:p-5">
          <dt className="text-sm text-ink-2">{i.label}</dt>
          <dd className={cn('mt-2 text-2xl font-medium tabular-nums sm:text-3xl', i.tone)}>{i.value.toLocaleString('en-US')}</dd>
          {i.note && <dd className="mt-1 text-xs text-ink-3">{i.note}</dd>}
        </div>
      ))}
    </dl>
  )
}

const IMPORT_STATUS: Record<ImportStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Waiting', tone: 'neutral' },
  running: { label: 'Collecting', tone: 'info' },
  done: { label: 'Done', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
}

function ImportRow({ imp, campaignActive }: { imp: LeadImport; campaignActive: boolean }) {
  const st = IMPORT_STATUS[imp.status] ?? IMPORT_STATUS.pending
  const open = imp.status === 'pending' || imp.status === 'running'
  const Icon = imp.status === 'done' ? CheckCircle2 : imp.status === 'failed' ? AlertCircle : open && campaignActive ? LoaderCircle : Clock
  return (
    <li className="space-y-2 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Icon size={16} className={cn('shrink-0', imp.status === 'failed' ? 'text-bad' : imp.status === 'done' ? 'text-ok' : 'text-info', open && campaignActive && 'animate-spin')} aria-hidden />
        <span className="min-w-0 truncate font-medium">{imp.listName || 'LinkedIn search'}</span>
        <Badge tone={st.tone}>{st.label}</Badge>
        <span className="text-sm tabular-nums text-ink-2 sm:ml-auto">
          {imp.collected.toLocaleString('en-US')} / {imp.max.toLocaleString('en-US')} collected
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-line" role="progressbar" aria-label={`${imp.listName || 'Search'} progress`} aria-valuemin={0} aria-valuemax={imp.max} aria-valuenow={imp.collected}>
        <div className={cn('h-full rounded-full transition-[width]', imp.status === 'failed' ? 'bg-bad' : 'bg-info')} style={{ width: `${pct(imp.collected, imp.max)}%` }} />
      </div>
      <p className="text-xs text-ink-3">
        <a href={imp.url} target="_blank" rel="noreferrer" className="break-all hover:text-brand hover:underline">
          {imp.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 120)}
        </a>
        {' · added '}
        {formatDateTime(imp.createdAt)}
        {open && !campaignActive && ' · starts when the campaign is running'}
      </p>
      {imp.error && <p className="text-sm text-bad" role="alert">{imp.error}</p>}
    </li>
  )
}

export function ImportProgress({ c }: { c: Campaign }) {
  if (!c.imports.length) return null
  const open = c.imports.filter((i) => i.status === 'pending' || i.status === 'running').length
  return (
    <section aria-labelledby="imports-title" className="rounded-2xl border border-line bg-panel p-5 sm:p-6">
      <h2 id="imports-title" className="mb-4 flex items-center gap-2 font-semibold">
        <Search size={18} className="text-brand" aria-hidden /> LinkedIn searches
        {open > 0 && <span className="text-sm font-normal text-ink-3">· {plural(open, 'search', 'searches')} in progress</span>}
      </h2>
      <ul className="divide-y divide-line">
        {c.imports.map((imp) => (
          <ImportRow key={imp.id} imp={imp} campaignActive={c.status === 'active'} />
        ))}
      </ul>
    </section>
  )
}
