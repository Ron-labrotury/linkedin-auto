/** Turning CSV files, pasted URLs and search URLs into the API's lead inputs. Pure functions (tested). */
import type { LeadInput } from '@shared/types.ts'
import { nameFromPublicId, normalizeProfileUrl, publicIdFromUrl } from '@shared/linkedin-url.ts'

/** The API accepts at most this many leads per request. */
export const MAX_LEADS_PER_REQUEST = 5000
export const MAX_SEARCH_LEADS = 1000

/** Split CSV text into rows. Handles quoted fields with delimiters, quotes ("") and line breaks. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let quoted = false
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const endRow = () => {
    row.push(cur)
    cur = ''
    if (row.some((c) => c.trim())) rows.push(row)
    row = []
  }
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"' && cur.trim() === '') {
      cur = ''
      quoted = true
    } else if (ch === delimiter) {
      row.push(cur)
      cur = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      endRow()
    } else cur += ch
  }
  endRow()
  return rows
}

/**
 * Excel exports use ";" in some locales and tabs for .tsv. Decided by the first line that has a
 * delimiter outside quotes, so a preamble (LinkedIn's Connections.csv starts with "Notes:" and a
 * quoted note) doesn't decide it.
 */
export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const options = [',', ';', '\t'] as const
  for (const line of text.split(/\r?\n/, 50)) {
    const unquoted = line.replace(/"[^"]*"/g, '')
    const count = (d: string) => unquoted.split(d).length - 1
    const best = options.reduce((b, d) => (count(d) > count(b) ? d : b), ',' as ',' | ';' | '\t')
    if (count(best) > 0) return best
  }
  return ','
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '')
const isUrlish = (h: string) => /url|link|linkedin|website|domain|http|email|mail|phone/.test(h)
/** Header names that can label the profile URL column. */
const isUrlHeader = (h: string) => isUrlish(h) || h.includes('profile')
/** Lines export tools put above the real header ("Notes:", "Exported on …"). */
const isPreamble = (row: string[]) => row.filter((c) => c.trim()).length < 2 || /^(notes?|exported|generated|source)\b/i.test(row[0]?.trim() ?? '')

/** Index of the column matching one of `exact` names, else containing one of `partial` (non-URL columns only). */
function findColumn(headers: string[], used: Set<number>, exact: string[], partial: string[] = []) {
  const free = (i: number) => !used.has(i) && !isUrlish(headers[i])
  let i = headers.findIndex((h, n) => free(n) && exact.includes(h))
  if (i < 0 && partial.length) i = headers.findIndex((h, n) => free(n) && partial.some((p) => h.includes(p)))
  if (i >= 0) used.add(i)
  return i
}

const clip = (s: string | undefined, n: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

export interface CsvImport {
  leads: LeadInput[]
  /** data rows without a valid LinkedIn profile URL */
  invalidRows: number
  /** rows whose profile was already listed above */
  duplicateRows: number
  /** which columns were recognised, for the summary */
  columns: string[]
  error?: string
}

/**
 * Leads from a CSV export. The LinkedIn URL column is found by its content (the column with the most
 * profile URLs), so any header name works; names, company, title/headline and location are matched by header.
 */
export function leadsFromCsv(text: string, listName = ''): CsvImport {
  const empty = (error: string): CsvImport => ({ leads: [], invalidRows: 0, duplicateRows: 0, columns: [], error })
  const rows = parseCsv(text, detectDelimiter(text))
  if (!rows.length) return empty('The file is empty.')

  const width = Math.max(...rows.map((r) => r.length))
  const sample = rows.slice(0, 500)
  let urlCol = -1
  let best = 0
  for (let c = 0; c < width; c++) {
    const score = sample.filter((r) => normalizeProfileUrl(r[c] ?? '')).length
    if (score > best) {
      best = score
      urlCol = c
    }
  }
  if (urlCol < 0) return empty('Couldn’t find a column with LinkedIn profile URLs (like https://www.linkedin.com/in/jane-doe).')

  // The header is above the first profile URL (none when the first row already holds one). Exports
  // like LinkedIn's Connections.csv put a preamble ("Notes:", a quoted note) above it: prefer the row
  // that labels the URL column, else the first row that isn't preamble. Rows above it are ignored.
  const firstData = rows.findIndex((r) => normalizeProfileUrl(r[urlCol] ?? ''))
  let headerIdx = -1
  if (firstData > 0) {
    const above = rows.slice(0, firstData)
    headerIdx = above.findIndex((r) => !isPreamble(r) && isUrlHeader(norm(r[urlCol] ?? '')))
    if (headerIdx < 0) headerIdx = above.findIndex((r) => !isPreamble(r))
    if (headerIdx < 0) headerIdx = 0
  }
  const hasHeader = headerIdx >= 0
  const headers = hasHeader ? rows[headerIdx].map(norm) : []
  const raw = hasHeader ? rows[headerIdx] : []
  const used = new Set([urlCol])
  const first = findColumn(headers, used, ['firstname', 'first', 'givenname', 'fname', 'forename'])
  const last = findColumn(headers, used, ['lastname', 'last', 'surname', 'familyname', 'lname'])
  const full = first < 0 || last < 0 ? findColumn(headers, used, ['name', 'fullname', 'contactname', 'personname', 'contact']) : -1
  const company = findColumn(headers, used, ['company', 'companyname', 'currentcompany', 'organization', 'organisation', 'employer', 'account', 'accountname'], ['company', 'organi', 'employer'])
  const title = findColumn(headers, used, ['headline', 'title', 'jobtitle', 'position', 'role', 'occupation', 'currenttitle'], ['headline', 'title', 'position', 'occupation'])
  const location = findColumn(headers, used, ['location', 'city', 'region', 'geography', 'country'], ['location', 'city'])

  const columns = [urlCol, first, last, full, company, title, location].filter((i) => i >= 0).map((i) => raw[i]?.trim()).filter(Boolean) as string[]
  const leads: LeadInput[] = []
  const seen = new Set<string>()
  let invalidRows = 0
  let duplicateRows = 0
  for (const r of hasHeader ? rows.slice(headerIdx + 1) : rows) {
    const url = normalizeProfileUrl(r[urlCol] ?? '')
    if (!url) {
      invalidRows++
      continue
    }
    if (seen.has(url)) {
      duplicateRows++
      continue
    }
    seen.add(url)
    const cell = (i: number) => (i >= 0 ? r[i] : '')
    let firstName = clip(cell(first), 100)
    let lastName = clip(cell(last), 100)
    if (full >= 0 && (!firstName || !lastName)) {
      const parts = clip(cell(full), 200).split(' ').filter(Boolean)
      firstName ||= clip(parts[0], 100)
      lastName ||= clip(parts.slice(1).join(' '), 100)
    }
    const lead: LeadInput = { profileUrl: url }
    if (firstName) lead.firstName = firstName
    if (lastName) lead.lastName = lastName
    const headline = clip(cell(title), 300)
    if (headline) lead.headline = headline
    const co = clip(cell(company), 200)
    if (co) lead.company = co
    const loc = clip(cell(location), 200)
    if (loc) lead.location = loc
    if (listName) lead.listName = listName
    leads.push(lead)
  }
  if (!leads.length) return { leads, invalidRows, duplicateRows, columns, error: 'No row has a valid LinkedIn profile URL.' }
  return { leads, invalidRows, duplicateRows, columns }
}

/** A readable list name for a people-search URL, e.g. "Search: cto pune". */
export function searchListName(url: string) {
  try {
    const kw = new URL(url.trim()).searchParams.get('keywords')?.trim()
    if (kw) return `Search: ${kw}`.slice(0, 100)
  } catch {
    /* not a URL – fall through */
  }
  return 'LinkedIn search'
}

/** Leads present in several lists are kept once (first list wins). */
export function dedupeLeads(lists: { leads: LeadInput[] }[]): LeadInput[] {
  const seen = new Set<string>()
  const out: LeadInput[] = []
  for (const l of lists)
    for (const lead of l.leads) {
      const key = normalizeProfileUrl(lead.profileUrl) ?? lead.profileUrl
      if (seen.has(key)) continue
      seen.add(key)
      out.push(lead)
    }
  return out
}

/** Name to show for a lead input: the typed name, else a guess from the profile URL. */
export function leadName(l: LeadInput) {
  const typed = [l.firstName, l.lastName].filter(Boolean).join(' ')
  if (typed) return typed
  const id = publicIdFromUrl(l.profileUrl)
  if (!id) return 'LinkedIn member'
  const g = nameFromPublicId(id)
  return `${g.firstName} ${g.lastName}`
}
