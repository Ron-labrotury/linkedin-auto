import { useId, useMemo, useState, type DragEvent } from 'react'
import { Search, Link2, FileSpreadsheet, Upload, ArrowLeft, Info } from 'lucide-react'
import type { LeadInput, SearchImportInput } from '@shared/types.ts'
import { isValidSearchUrl, parseProfileUrls } from '@shared/linkedin-url.ts'
import { errorMessage } from '../../api/client'
import { cn, plural } from '../../lib/utils'
import { Alert, Button, Field, Input, Modal, Textarea } from '../ui'
import { MAX_LEADS_PER_REQUEST, MAX_SEARCH_LEADS, leadsFromCsv, searchListName } from './leadImport'

type Source = 'search' | 'urls' | 'csv'

const SOURCES: { id: Source; title: string; body: string; icon: typeof Search }[] = [
  { id: 'search', title: 'LinkedIn search', body: 'Paste a people-search URL. Your LinkedIn account collects the results for you.', icon: Search },
  { id: 'urls', title: 'Paste profile URLs', body: 'Add specific people by their LinkedIn profile links.', icon: Link2 },
  { id: 'csv', title: 'Upload CSV', body: 'Import a file with a LinkedIn profile URL column.', icon: FileSpreadsheet },
]

export interface AddLeadsResult {
  listName: string
  leads: LeadInput[]
  searchImports: SearchImportInput[]
}

const MAX_FILE_BYTES = 10 * 1024 * 1024

export function AddLeadsModal({
  open,
  onClose,
  onAdd,
}: {
  open: boolean
  onClose: () => void
  /** May return a promise: the modal shows progress, closes on success and shows the error otherwise. */
  onAdd: (r: AddLeadsResult) => void | Promise<void>
}) {
  const [source, setSource] = useState<Source | null>(null)
  const [searchUrl, setSearchUrl] = useState('')
  const [maxLeads, setMaxLeads] = useState('100')
  const [urls, setUrls] = useState('')
  const [csv, setCsv] = useState<{ name: string; text: string } | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [listName, setListName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileId = useId()

  const parsedUrls = useMemo(() => parseProfileUrls(urls), [urls])
  const csvResult = useMemo(() => (csv ? leadsFromCsv(csv.text) : null), [csv])
  const max = Math.floor(Number(maxLeads))

  const reset = () => {
    setSource(null)
    setSearchUrl('')
    setMaxLeads('100')
    setUrls('')
    setCsv(null)
    setFileError(null)
    setListName('')
    setError(null)
    setBusy(false)
  }
  const close = () => {
    if (busy) return
    reset()
    onClose()
  }

  const defaultName =
    source === 'search' ? searchListName(searchUrl) : source === 'csv' ? (csv?.name.replace(/\.(csv|tsv|txt)$/i, '') ?? 'CSV import') : 'Profile URLs'
  const name = (listName.trim() || defaultName).slice(0, 100)

  const searchError = !searchUrl.trim()
    ? null
    : /linkedin\.com\/sales\//i.test(searchUrl)
      ? 'Sales Navigator searches aren’t supported. Use a regular LinkedIn people search.'
      : !isValidSearchUrl(searchUrl)
        ? 'Use a LinkedIn people-search URL (https://www.linkedin.com/search/results/people/?…)'
        : null
  const maxError = !Number.isInteger(max) || max < 1 || max > MAX_SEARCH_LEADS ? `Enter a number from 1 to ${MAX_SEARCH_LEADS.toLocaleString('en-US')}` : null

  const count = source === 'urls' ? parsedUrls.valid.length : source === 'csv' ? (csvResult?.leads.length ?? 0) : 0
  const tooMany = count > MAX_LEADS_PER_REQUEST
  const valid =
    source === 'search'
      ? !!searchUrl.trim() && !searchError && !maxError
      : source === 'urls'
        ? parsedUrls.valid.length > 0 && !tooMany
        : source === 'csv'
          ? !!csvResult && !csvResult.error && !tooMany
          : false

  const readFile = async (f: File | undefined) => {
    setFileError(null)
    if (!f) return
    if (f.size > MAX_FILE_BYTES) {
      setCsv(null)
      setFileError('The file is larger than 10 MB. Split it into smaller files.')
      return
    }
    try {
      setCsv({ name: f.name, text: await f.text() })
    } catch {
      setCsv(null)
      setFileError('Couldn’t read the file.')
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    void readFile(e.dataTransfer.files?.[0])
  }

  const submit = async () => {
    if (!valid || busy || !source) return
    const result: AddLeadsResult =
      source === 'search'
        ? { listName: name, leads: [], searchImports: [{ url: searchUrl.trim(), max, listName: name }] }
        : {
            listName: name,
            leads: (source === 'urls' ? parsedUrls.valid.map((profileUrl): LeadInput => ({ profileUrl })) : (csvResult?.leads ?? [])).map((l) => ({ ...l, listName: name })),
            searchImports: [],
          }
    setError(null)
    const out = onAdd(result)
    if (out instanceof Promise) {
      setBusy(true)
      try {
        await out
      } catch (e) {
        setError(errorMessage(e))
        setBusy(false)
        return
      }
    }
    reset()
    onClose()
  }

  const current = SOURCES.find((s) => s.id === source)

  return (
    <Modal open={open} onClose={close} className="max-w-3xl px-5 py-7 sm:px-10">
      <p className="text-sm font-semibold uppercase tracking-wide text-ink-2">Add leads · Step {source ? 2 : 1} of 2</p>
      <h3 className="mt-2 pr-8 text-2xl font-semibold">{current ? current.title : 'Where are your leads?'}</h3>

      <div className="mt-6 min-h-56">
        {!source && (
          <div className="grid gap-3 sm:grid-cols-3">
            {SOURCES.map(({ id, title, body, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setSource(id)}
                className="flex cursor-pointer flex-col items-start gap-3 rounded-xl border border-line p-4 text-left transition-colors hover:border-brand hover:bg-brand-soft/40 focus-visible:outline-2 focus-visible:outline-brand"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-panel-2 text-brand" aria-hidden><Icon size={20} /></span>
                <span>
                  <span className="block font-semibold">{title}</span>
                  <span className="mt-1 block text-sm text-ink-2">{body}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        {source === 'search' && (
          <div className="space-y-5">
            <Field label="LinkedIn search URL" error={searchError} hint="Run a People search on linkedin.com, apply your filters, then copy the address bar.">
              <Input
                value={searchUrl}
                onChange={(e) => setSearchUrl(e.target.value)}
                placeholder="https://www.linkedin.com/search/results/people/?keywords=…"
                aria-invalid={!!searchError}
                autoFocus
              />
            </Field>
            <Field label="Max leads to collect" error={maxError} hint={`1 – ${MAX_SEARCH_LEADS.toLocaleString('en-US')}. LinkedIn shows at most 1,000 results per search.`}>
              <Input type="number" inputMode="numeric" min={1} max={MAX_SEARCH_LEADS} value={maxLeads} onChange={(e) => setMaxLeads(e.target.value)} className="w-40" aria-invalid={!!maxError} />
            </Field>
            <Alert tone="info">
              The leads are collected in the background by your LinkedIn account after the campaign is launched – page by page, inside your active hours and
              with the same random pauses as every other action. New people join the campaign as they are found.
            </Alert>
          </div>
        )}

        {source === 'urls' && (
          <div className="space-y-3">
            <Field label="Profile URLs" hint="One per line (commas and spaces work too). Duplicates are removed.">
              <Textarea
                rows={8}
                value={urls}
                onChange={(e) => setUrls(e.target.value)}
                placeholder={'https://www.linkedin.com/in/jane-doe/\nhttps://www.linkedin.com/in/rahul-sharma-12345/'}
                className="font-mono text-[13px]"
                autoFocus
              />
            </Field>
            {urls.trim() && (
              <p className="text-sm" aria-live="polite">
                <span className="font-medium text-ok">{plural(parsedUrls.valid.length, 'valid profile')}</span>
                {parsedUrls.invalid.length > 0 && (
                  <span className="text-bad">
                    {' '}· {plural(parsedUrls.invalid.length, 'invalid line')} (e.g. “{parsedUrls.invalid[0].slice(0, 50)}”) – these are ignored
                  </span>
                )}
              </p>
            )}
          </div>
        )}

        {source === 'csv' && (
          <div className="space-y-4">
            <label
              htmlFor={fileId}
              onDragOver={(e) => {
                e.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={cn(
                'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-8 text-center transition-colors focus-within:border-brand hover:border-brand',
                dragging ? 'border-brand bg-brand-soft/40' : 'border-line-strong',
              )}
            >
              <Upload size={28} className="text-brand" aria-hidden />
              <span className="font-medium">{csv ? csv.name : 'Choose a .csv file or drop it here'}</span>
              <span className="text-sm text-ink-3">Needs a LinkedIn profile URL column. Optional: first name, last name, company, title / headline, location.</span>
              <input
                id={fileId}
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
                className="sr-only"
                onChange={(e) => {
                  void readFile(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
            </label>
            {fileError && <Alert tone="bad">{fileError}</Alert>}
            {csvResult?.error && <Alert tone="bad">{csvResult.error}</Alert>}
            {csvResult && !csvResult.error && (
              <div className="space-y-3">
                <p className="text-sm" aria-live="polite">
                  <span className="font-medium text-ok">{plural(csvResult.leads.length, 'lead')} found</span>
                  {csvResult.invalidRows > 0 && <span className="text-warn"> · {plural(csvResult.invalidRows, 'row')} without a valid profile URL skipped</span>}
                  {csvResult.duplicateRows > 0 && <span className="text-ink-3"> · {plural(csvResult.duplicateRows, 'duplicate')} removed</span>}
                </p>
                {csvResult.columns.length > 0 && <p className="text-xs text-ink-3">Columns used: {csvResult.columns.join(', ')}</p>}
                <ul className="divide-y divide-line rounded-xl border border-line text-sm">
                  {csvResult.leads.slice(0, 4).map((l) => (
                    <li key={l.profileUrl} className="flex min-w-0 flex-wrap items-baseline gap-x-2 px-3 py-2">
                      <span className="font-medium">{[l.firstName, l.lastName].filter(Boolean).join(' ') || 'Name from profile'}</span>
                      <span className="min-w-0 truncate text-xs text-ink-3">{[l.headline, l.company].filter(Boolean).join(' · ') || l.profileUrl}</span>
                    </li>
                  ))}
                  {csvResult.leads.length > 4 && <li className="px-3 py-2 text-xs text-ink-3">+ {plural(csvResult.leads.length - 4, 'more lead')}</li>}
                </ul>
              </div>
            )}
          </div>
        )}

        {source && (
          <div className="mt-6 space-y-3">
            <Field label="List name" hint="Shown on each lead so you know where it came from.">
              <Input value={listName} onChange={(e) => setListName(e.target.value)} placeholder={defaultName} maxLength={100} />
            </Field>
            {tooMany && (
              <Alert tone="bad">
                That’s {count.toLocaleString('en-US')} leads – at most {MAX_LEADS_PER_REQUEST.toLocaleString('en-US')} can be added at once. Split the list into smaller parts.
              </Alert>
            )}
            {source !== 'search' && count > 0 && !tooMany && (
              <p className="flex items-center gap-2 text-xs text-ink-3">
                <Info size={14} aria-hidden /> Leads already in this campaign are skipped automatically.
              </p>
            )}
            {error && <Alert tone="bad">{error}</Alert>}
          </div>
        )}
      </div>

      <div className="mt-8 flex flex-wrap justify-end gap-3">
        {source ? (
          <Button variant="outline" size="lg" onClick={() => setSource(null)} disabled={busy}>
            <ArrowLeft size={16} /> Back
          </Button>
        ) : (
          <Button variant="outline" size="lg" onClick={close}>Cancel</Button>
        )}
        {source && (
          <Button size="lg" disabled={!valid} loading={busy} onClick={() => void submit()}>
            {source === 'search' ? 'Add search' : count ? `Add ${plural(count, 'lead')}` : 'Add leads'}
          </Button>
        )}
      </div>
    </Modal>
  )
}
