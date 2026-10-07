import { useMemo, useState } from 'react'
import { Search, Compass, Link2, FileSpreadsheet, ListChecks, Upload } from 'lucide-react'
import type { Lead, LeadSource } from '../../types'
import { useStore } from '../../store/useStore'
import { generateSampleLeads } from '../../data/mock'
import { cn, isValidSearchUrl, nameFromProfileUrl, parseProfileUrls, uid } from '../../lib/utils'
import { Button, Checkbox, Field, Input, Modal, Select, Textarea } from '../ui'

const SOURCES: { id: LeadSource; title: string; body: string; icon: typeof Search }[] = [
  { id: 'search', title: 'LinkedIn search', body: 'Paste a people-search URL from LinkedIn.', icon: Search },
  { id: 'sales_nav', title: 'Sales Navigator', body: 'Paste a Sales Navigator search or lead-list URL.', icon: Compass },
  { id: 'urls', title: 'Paste profile URLs', body: 'Add specific people by their profile links.', icon: Link2 },
  { id: 'csv', title: 'Upload CSV', body: 'Import a file with a LinkedIn URL column.', icon: FileSpreadsheet },
  { id: 'existing', title: 'Existing leads', body: 'Reuse leads you imported earlier.', icon: ListChecks },
]

const STEP_TITLES = ['Choose a source', '', 'Name your list', 'Review']

export interface AddLeadsResult {
  listName: string
  source: LeadSource
  leads: Lead[]
}

/** Minimal CSV parser (handles quoted fields with commas/newlines). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') q = false
      else cur += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { row.push(cur); cur = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cur); cur = ''
      if (row.some((c) => c.trim())) rows.push(row)
      row = []
    } else cur += ch
  }
  row.push(cur)
  if (row.some((c) => c.trim())) rows.push(row)
  return rows
}

function leadsFromCsv(text: string, listName: string): { leads: Lead[]; error?: string } {
  const rows = parseCsv(text)
  if (rows.length < 2) return { leads: [], error: 'The file needs a header row and at least one lead.' }
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const col = (...names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)))
  const urlCol = col('linkedin', 'profile', 'url')
  if (urlCol < 0) return { leads: [], error: 'Couldn’t find a LinkedIn URL column (e.g. “linkedin_url”).' }
  const fn = col('first'), ln = col('last'), co = col('company', 'organization'), em = col('email'), ti = col('title', 'headline')
  const leads: Lead[] = []
  for (const r of rows.slice(1)) {
    const url = r[urlCol]?.trim()
    if (!url || !parseProfileUrls(url).valid.length) continue
    const guess = nameFromProfileUrl(url)
    const company = co >= 0 ? r[co]?.trim() : ''
    leads.push({
      id: uid('lead'),
      firstName: (fn >= 0 && r[fn]?.trim()) || guess.firstName,
      lastName: (ln >= 0 && r[ln]?.trim()) || guess.lastName,
      headline: (ti >= 0 && r[ti]?.trim()) || (company ? `at ${company}` : ''),
      company: company || '',
      location: '',
      profileUrl: url,
      email: em >= 0 ? r[em]?.trim() || undefined : undefined,
      status: 'queued',
      listName,
      tags: [],
    })
  }
  if (!leads.length) return { leads, error: 'No rows had a valid LinkedIn profile URL.' }
  return { leads }
}

export function AddLeadsModal({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (r: AddLeadsResult) => void }) {
  const allLeads = useStore((s) => s.leads)
  const [step, setStep] = useState(0)
  const [source, setSource] = useState<LeadSource>('urls')
  const [searchUrl, setSearchUrl] = useState('')
  const [maxLeads, setMaxLeads] = useState(100)
  const [urls, setUrls] = useState('')
  const [csv, setCsv] = useState<{ name: string; text: string } | null>(null)
  const [existingList, setExistingList] = useState('')
  const [listName, setListName] = useState('')
  const [onlyUnassigned, setOnlyUnassigned] = useState(true)

  const parsedUrls = useMemo(() => parseProfileUrls(urls), [urls])
  const csvResult = useMemo(() => (csv ? leadsFromCsv(csv.text, listName || csv.name) : null), [csv, listName])
  const lists = useMemo(() => {
    const m = new Map<string, number>()
    for (const l of allLeads) m.set(l.listName, (m.get(l.listName) ?? 0) + 1)
    return [...m.entries()]
  }, [allLeads])

  const reset = () => {
    setStep(0); setSearchUrl(''); setUrls(''); setCsv(null); setExistingList(''); setListName(''); setMaxLeads(100)
  }
  const close = () => { reset(); onClose() }

  const inputValid =
    source === 'search' || source === 'sales_nav'
      ? isValidSearchUrl(searchUrl, source) && maxLeads > 0
      : source === 'urls'
        ? parsedUrls.valid.length > 0
        : source === 'csv'
          ? !!csvResult && !csvResult.error
          : !!existingList

  const buildLeads = (): Lead[] => {
    const name = listName.trim()
    switch (source) {
      case 'urls':
        return parsedUrls.valid.map((url) => ({
          id: uid('lead'),
          ...nameFromProfileUrl(url),
          headline: '',
          company: '',
          location: '',
          profileUrl: url,
          status: 'queued',
          listName: name,
          tags: [],
        }))
      case 'csv':
        return (csvResult?.leads ?? []).map((l) => ({ ...l, listName: name }))
      case 'existing':
        return allLeads.filter((l) => l.listName === existingList && (!onlyUnassigned || !l.campaignId))
      default:
        return generateSampleLeads(Math.min(maxLeads, 50), name)
    }
  }

  const estimate =
    source === 'urls' ? parsedUrls.valid.length
      : source === 'csv' ? csvResult?.leads.length ?? 0
        : source === 'existing' ? allLeads.filter((l) => l.listName === existingList && (!onlyUnassigned || !l.campaignId)).length
          : Math.min(maxLeads, 50)

  const canNext = step === 0 ? true : step === 1 ? inputValid : step === 2 ? !!listName.trim() : estimate > 0

  const next = () => {
    if (step === 1 && !listName) {
      setListName(source === 'existing' ? existingList : source === 'csv' ? csv?.name.replace(/\.csv$/i, '') ?? '' : '')
    }
    if (step < 3) setStep(step + 1)
    else {
      onAdd({ listName: listName.trim(), source, leads: buildLeads() })
      close()
    }
  }

  const stepTitle = step === 1 ? SOURCES.find((s) => s.id === source)!.title : STEP_TITLES[step]

  return (
    <Modal open={open} onClose={close} className="max-w-3xl px-6 py-8 sm:px-12">
      <p className="flex items-center gap-3 text-sm font-semibold uppercase tracking-wide">
        Create a list of leads <span className="size-1 rounded-full bg-ink-2" /> <span className="text-ink-2">Step {step + 1} / 4</span>
      </p>
      <div className="mt-3 flex gap-2">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={cn('h-0.5 w-20 rounded-full', i <= step ? 'bg-brand' : 'bg-line-strong')} />
        ))}
      </div>

      <h3 className="mt-8 text-2xl font-semibold">{stepTitle}</h3>

      <div className="mt-6 min-h-56">
        {step === 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {SOURCES.map(({ id, title, body, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setSource(id)}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-xl border p-4 text-left transition-colors',
                  source === id ? 'border-brand bg-brand-soft/60' : 'border-line hover:border-line-strong',
                )}
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-panel-2 text-brand"><Icon size={20} /></span>
                <span>
                  <span className="block font-semibold">{title}</span>
                  <span className="block text-sm text-ink-2">{body}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        {step === 1 && (source === 'search' || source === 'sales_nav') && (
          <div className="space-y-5">
            <Field
              label={source === 'search' ? 'LinkedIn search URL' : 'Sales Navigator URL'}
              hint={source === 'search' ? 'Run a People search on LinkedIn, apply filters, then copy the address bar.' : 'Open a Sales Navigator lead search or saved list and copy the URL.'}
            >
              <Input
                value={searchUrl}
                onChange={(e) => setSearchUrl(e.target.value)}
                placeholder={source === 'search' ? 'https://www.linkedin.com/search/results/people/?keywords=…' : 'https://www.linkedin.com/sales/search/people?…'}
              />
            </Field>
            {searchUrl && !isValidSearchUrl(searchUrl, source) && <p className="text-sm text-bad">That doesn’t look like a {source === 'search' ? 'LinkedIn people-search' : 'Sales Navigator'} URL.</p>}
            <Field label="Maximum leads to collect" hint={source === 'search' ? 'LinkedIn shows at most 1,000 results per search.' : 'Sales Navigator shows at most 2,500 results per search.'}>
              <Input type="number" min={1} max={source === 'search' ? 1000 : 2500} value={maxLeads} onChange={(e) => setMaxLeads(Math.max(0, Number(e.target.value) || 0))} className="w-40" />
            </Field>
            <p className="rounded-lg border border-info/30 bg-info/10 p-3 text-sm text-info">
              Demo mode: up to 50 sample leads are generated. Real collection is done by the backend.
            </p>
          </div>
        )}

        {step === 1 && source === 'urls' && (
          <div className="space-y-3">
            <p className="text-ink-2">Add the LinkedIn profile URLs in the field below, one per line</p>
            <Textarea
              rows={7}
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
              placeholder={'https://www.linkedin.com/in/mike-johnson-1918171691/\nhttps://www.linkedin.com/in/daniel-wilson-1532096729/'}
              className="font-mono text-[13px]"
              autoFocus
            />
            {urls.trim() && (
              <p className="text-sm">
                <span className="text-ok">{parsedUrls.valid.length} valid</span>
                {parsedUrls.invalid.length > 0 && (
                  <span className="text-bad"> · {parsedUrls.invalid.length} invalid (e.g. “{parsedUrls.invalid[0].slice(0, 40)}”)</span>
                )}
              </p>
            )}
          </div>
        )}

        {step === 1 && source === 'csv' && (
          <div className="space-y-4">
            <label className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-line-strong p-10 text-center hover:border-brand">
              <Upload size={28} className="text-brand" />
              <span className="font-medium">{csv ? csv.name : 'Choose a .csv file'}</span>
              <span className="text-sm text-ink-3">Columns: linkedin_url (required), first_name, last_name, company, title, email</span>
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0]
                  if (f) setCsv({ name: f.name, text: await f.text() })
                }}
              />
            </label>
            {csvResult?.error && <p className="text-sm text-bad">{csvResult.error}</p>}
            {csvResult && !csvResult.error && <p className="text-sm text-ok">{csvResult.leads.length} leads found</p>}
          </div>
        )}

        {step === 1 && source === 'existing' && (
          <div className="space-y-4">
            <Field label="Leads list">
              <Select value={existingList} onChange={(e) => setExistingList(e.target.value)}>
                <option value="">Select a list…</option>
                {lists.map(([name, n]) => <option key={name} value={name}>{name} ({n})</option>)}
              </Select>
            </Field>
            <Checkbox checked={onlyUnassigned} onChange={setOnlyUnassigned} label="Only leads not used in another campaign" />
          </div>
        )}

        {step === 2 && (
          <Field label="List name" hint="Used to find these leads later on the Leads page.">
            <Input value={listName} onChange={(e) => setListName(e.target.value)} placeholder="e.g. Pune CTOs – October" autoFocus maxLength={60} />
          </Field>
        )}

        {step === 3 && (
          <dl className="divide-y divide-line rounded-xl border border-line">
            {[
              ['Source', SOURCES.find((s) => s.id === source)!.title],
              ['List name', listName],
              ['Leads to add', String(estimate)],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 p-4">
                <dt className="text-ink-2">{k}</dt>
                <dd className="truncate font-semibold">{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <div className="mt-8 flex justify-end gap-4">
        <Button variant="outline" size="lg" className="w-32" onClick={() => (step ? setStep(step - 1) : close())}>
          {step ? 'Back' : 'Cancel'}
        </Button>
        <Button size="lg" className="w-32" disabled={!canNext} onClick={next}>
          {step === 3 ? `Add ${estimate}` : 'Next'}
        </Button>
      </div>
    </Modal>
  )
}
