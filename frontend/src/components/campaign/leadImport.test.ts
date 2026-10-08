// Run: node --test "frontend/src/**/*.test.ts"
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Plain Node doesn't know Vite's "@shared/*" alias or extensionless imports.
registerHooks({
  resolve: (s, c, next) =>
    next(s.startsWith('@shared/') ? new URL(`../../../../shared/${s.slice(8)}`, import.meta.url).href : /^\.\.?\/(.*\/)?[^./]+$/.test(s) ? `${s}.ts` : s, c),
})
const { parseCsv, detectDelimiter, leadsFromCsv, searchListName, dedupeLeads, leadName, MAX_LEADS_PER_REQUEST } = await import('./leadImport.ts')
const { settingsErrors, DEFAULT_CAMPAIGN_SETTINGS } = await import('./settings.ts')

test('parseCsv handles quotes, escaped quotes, embedded delimiters and line breaks', () => {
  const rows = parseCsv('a,b,c\r\n"x, y","he said ""hi""","multi\nline"\n\n1,,3')
  assert.deepEqual(rows, [
    ['a', 'b', 'c'],
    ['x, y', 'he said "hi"', 'multi\nline'],
    ['1', '', '3'],
  ])
})

test('parseCsv strips a UTF-8 BOM and supports other delimiters', () => {
  assert.deepEqual(parseCsv('﻿name;url\nA;B', ';'), [
    ['name', 'url'],
    ['A', 'B'],
  ])
  assert.equal(detectDelimiter('first;last;linkedin\nx;y;z'), ';')
  assert.equal(detectDelimiter('first\tlast\tlinkedin'), '\t')
  assert.equal(detectDelimiter('first,last,linkedin'), ',')
})

test('leadsFromCsv maps the usual columns and normalises URLs', () => {
  const csv = [
    'First Name,Last Name,Company,Title,Location,LinkedIn URL,Email',
    'Jane,Doe,Acme,CTO,"Pune, India",https://linkedin.com/in/Jane-Doe?trk=x,jane@acme.com',
    'Raj,Kumar,Globex,Head of Sales,Mumbai,https://www.linkedin.com/in/raj-kumar-123/,',
  ].join('\n')
  const r = leadsFromCsv(csv, 'My list')
  assert.equal(r.error, undefined)
  assert.equal(r.invalidRows, 0)
  assert.deepEqual(r.leads[0], {
    profileUrl: 'https://www.linkedin.com/in/jane-doe/',
    firstName: 'Jane',
    lastName: 'Doe',
    headline: 'CTO',
    company: 'Acme',
    location: 'Pune, India',
    listName: 'My list',
  })
  assert.equal(r.leads[1].profileUrl, 'https://www.linkedin.com/in/raj-kumar-123/')
  assert.ok(r.columns.includes('LinkedIn URL'))
  assert.ok(!r.columns.includes('Email'))
})

test('leadsFromCsv finds the URL column by content, splits full names and counts bad rows', () => {
  const csv = [
    'Name;Profile;Organisation;Headline',
    'Mike Johnson Jr;https://www.linkedin.com/in/mike-johnson/;Initech;Engineer',
    'No Url;not a url;X;Y',
    'Dup;https://linkedin.com/in/mike-johnson;Z;W',
  ].join('\n')
  const r = leadsFromCsv(csv)
  assert.equal(r.leads.length, 1)
  assert.equal(r.invalidRows, 1)
  assert.equal(r.duplicateRows, 1)
  assert.equal(r.leads[0].firstName, 'Mike')
  assert.equal(r.leads[0].lastName, 'Johnson Jr')
  assert.equal(r.leads[0].company, 'Initech')
  assert.equal(r.leads[0].headline, 'Engineer')
  assert.equal(r.leads[0].listName, undefined)
})

test('leadsFromCsv works without a header row and clips long values', () => {
  const r = leadsFromCsv('https://www.linkedin.com/in/a-b/,x\nhttps://www.linkedin.com/in/c-d/,y')
  assert.equal(r.leads.length, 2)
  assert.deepEqual(r.leads[0], { profileUrl: 'https://www.linkedin.com/in/a-b/' })
  const long = leadsFromCsv(`url,headline,first name\nhttps://www.linkedin.com/in/a-b/,${'x'.repeat(500)},"  Jane \n Mary "`)
  assert.equal(long.leads[0].headline?.length, 300)
  assert.equal(long.leads[0].firstName, 'Jane Mary')
})

test('leadsFromCsv reads LinkedIn’s own Connections.csv export (preamble above the header)', () => {
  const csv = [
    'Notes:',
    '"When exporting your connection data, you may notice that some of the email addresses are missing. You will only see email addresses for connections who have allowed their connections to see or download their email address using this setting https://www.linkedin.com/psettings/privacy/email. You can learn more here https://www.linkedin.com/help/linkedin/answer/261"',
    '',
    'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
    'Jane,Doe,https://www.linkedin.com/in/jdoe,,Acme,CTO,01 Oct 2026',
    'John,Smith,https://www.linkedin.com/in/jsmith42,john@globex.com,Globex,VP Sales,02 Oct 2026',
  ].join('\r\n')
  assert.equal(detectDelimiter(csv), ',')
  const r = leadsFromCsv(csv)
  assert.equal(r.error, undefined)
  assert.equal(r.invalidRows, 0, 'preamble lines are not counted as rows without a URL')
  assert.deepEqual(r.leads, [
    { profileUrl: 'https://www.linkedin.com/in/jdoe/', firstName: 'Jane', lastName: 'Doe', headline: 'CTO', company: 'Acme' },
    { profileUrl: 'https://www.linkedin.com/in/jsmith42/', firstName: 'John', lastName: 'Smith', headline: 'VP Sales', company: 'Globex' },
  ])
  assert.deepEqual(r.columns, ['URL', 'First Name', 'Last Name', 'Company', 'Position'])
})

test('leadsFromCsv skips a preamble before a semicolon header and still counts bad data rows', () => {
  const csv = ['Exported on 2026-10-01', '', 'Name;Profile;Company', 'No url;-;X', 'Jane Doe;https://www.linkedin.com/in/jane-doe;Acme'].join('\n')
  assert.equal(detectDelimiter(csv), ';')
  const r = leadsFromCsv(csv)
  assert.equal(r.invalidRows, 1)
  assert.deepEqual(r.leads, [{ profileUrl: 'https://www.linkedin.com/in/jane-doe/', firstName: 'Jane', lastName: 'Doe', company: 'Acme' }])
})

test('leadsFromCsv explains files it cannot use', () => {
  assert.match(leadsFromCsv('').error ?? '', /empty/)
  assert.match(leadsFromCsv('name,email\nJane,j@x.com').error ?? '', /LinkedIn profile URLs/)
  const companyPages = leadsFromCsv('Company LinkedIn\nhttps://www.linkedin.com/company/acme/')
  assert.ok(companyPages.error)
})

test('searchListName uses the search keywords', () => {
  assert.equal(searchListName('https://www.linkedin.com/search/results/people/?keywords=cto%20pune&origin=x'), 'Search: cto pune')
  assert.equal(searchListName('https://www.linkedin.com/search/results/people/?geoUrn=1'), 'LinkedIn search')
  assert.equal(searchListName('nope'), 'LinkedIn search')
})

test('dedupeLeads keeps the first occurrence across lists', () => {
  const out = dedupeLeads([
    { leads: [{ profileUrl: 'https://www.linkedin.com/in/a/', firstName: 'First' }] },
    { leads: [{ profileUrl: 'https://linkedin.com/in/A', firstName: 'Second' }, { profileUrl: 'https://www.linkedin.com/in/b/' }] },
  ])
  assert.deepEqual(
    out.map((l) => l.firstName ?? l.profileUrl),
    ['First', 'https://www.linkedin.com/in/b/'],
  )
})

test('leadName falls back to a name from the profile URL', () => {
  assert.equal(leadName({ profileUrl: 'x', firstName: 'Jane', lastName: 'Doe' }), 'Jane Doe')
  assert.equal(leadName({ profileUrl: 'https://www.linkedin.com/in/mike-johnson-19181/' }), 'Mike Johnson')
  assert.equal(leadName({ profileUrl: 'garbage' }), 'LinkedIn member')
  assert.equal(MAX_LEADS_PER_REQUEST, 5000)
})

test('settingsErrors mirrors the API ranges', () => {
  assert.deepEqual(settingsErrors('My campaign', DEFAULT_CAMPAIGN_SETTINGS), {})
  const errs = settingsErrors('  ', { ...DEFAULT_CAMPAIGN_SETTINGS, dailyInvites: 201, dailyMessages: -1, dailyProfileViews: 1.5 })
  assert.deepEqual(Object.keys(errs).sort(), ['name', 'settings.dailyInvites', 'settings.dailyMessages', 'settings.dailyProfileViews'])
  assert.ok(settingsErrors('x'.repeat(81), DEFAULT_CAMPAIGN_SETTINGS).name)
  assert.deepEqual(
    [DEFAULT_CAMPAIGN_SETTINGS.dailyInvites, DEFAULT_CAMPAIGN_SETTINGS.dailyMessages, DEFAULT_CAMPAIGN_SETTINGS.dailyProfileViews],
    [25, 40, 50],
  )
})
