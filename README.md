# linkedin-auto

LinkedIn outreach automation (Dripify-style): build campaigns from lead lists, design a
multi-step sequence (n8n-style canvas with Yes/No branches), and track results.

**Status:** frontend/UI only, running on sample data stored in the browser. The backend comes next.

## Run the frontend

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build
```

Requires Node 20.19+.

## Deploy to Vercel

The repo is ready for Vercel as is: `vercel.json` at the root builds `frontend/` and serves
`frontend/dist`.

1. On vercel.com: **Add New → Project**, then import `Ron-labrotury/linkedin-auto`.
2. Leave **Root Directory** as the repo root and the framework preset as detected. The settings in
   `vercel.json` (install, build, output) take priority over the dashboard.
3. Click **Deploy**. Pushes to `main` deploy to production, and other branches get preview URLs.

Every path is rewritten to `index.html`, so deep links like `/campaigns/123` work on refresh.
If you'd rather set **Root Directory** to `frontend`, that works too: `frontend/vercel.json`
carries the same rewrite.

No environment variables are needed yet.

## What's in the UI

| Page | Route | Highlights |
|---|---|---|
| Dashboard | `/` | Daily-limit rings, pending invitations + withdraw, unread messages, activity feed, recent campaigns |
| Campaigns | `/campaigns` | Search, "active only", start/pause toggle, delete |
| New campaign | `/campaigns/new` | 3 tabs: **Add Leads** → **Create a Sequence** → **Settings** → Launch / Save draft |
| Campaign detail | `/campaigns/:id` | Funnel stats, leads table, editable sequence, settings |
| Inbox | `/inbox` | Conversations + chat |
| Leads | `/leads` | Filters, bulk delete, CSV export, import |
| Teams | `/teams` | Invite / remove members |
| Settings | `/settings` | LinkedIn account, mailbox, safety, reset demo data |

**Add-leads wizard (4 steps):** source (LinkedIn search URL, Sales Navigator URL, pasted profile
URLs, CSV upload, existing list) → input with validation → list name → review.
Search/Sales Navigator imports generate sample leads until the backend scraper exists.

**Sequence builder** (`frontend/src/components/sequence/`): React Flow canvas with an auto tree
layout. Add steps from any `+`, insert between steps on an edge, click a step to edit it in the
side panel (delay, invite note with 300-char limit, message/email with `{{first_name}}`-style
variables and a live preview, condition type + wait window). Has templates, undo, zoom, fit and
full screen. Steps: view profile, follow, endorse, like post, invite, message, withdraw invite,
find email, send email, condition (invite accepted / connected / replied / has email / opened
email), end.

## Notes for the backend

- **Data model:** `frontend/src/types.ts`. A sequence is a tree stored flat:
  `{ rootId, steps: Record<id, { kind, delay, config, next | yes/no }> }`. The worker can walk it
  per lead: wait `delay`, run `kind`, then follow `next`, or for a condition, `yes`/`no` once it
  resolves or `withinDays` runs out.
- **API surface:** every mutation lives in `frontend/src/store/useStore.ts` (`createCampaign`,
  `toggleCampaign`, `addLeads`, `sendMessage`, …). Replace those bodies with API calls.
- **Validation** to repeat on the server: `validateSequence` in `frontend/src/lib/sequence.ts` and
  the daily limits in `components/campaign/CampaignSettingsForm.tsx`.
