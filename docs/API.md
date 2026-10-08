# HTTP API (contract)

Base path `/api`. JSON in and out. Types referenced below live in `shared/types.ts`.

**Auth:** every endpoint except `POST /auth/signup`, `POST /auth/login`, `GET /auth/invite/:token`
and `GET /health` requires `Authorization: Bearer <token>`. Missing/invalid/expired token → `401`.

**Errors:** any non-2xx response has body `ApiError` `{ error: string, details?: Record<string,string> }`.
Status codes: 400 validation (with `details` per field when useful; also `"Malformed URL"` for a path
with invalid percent-encoding such as `%ZZ`), 401 unauthenticated,
403 forbidden (role), 404 not found (also for other users' resources — never leak existence),
409 conflict (e.g. email taken), 422 business rule (e.g. "Pause the campaign before editing the sequence"),
429 too many failed sign-in / current-password attempts (with `Retry-After` in seconds), 500 unexpected.

All times in responses are ISO-8601 strings (UTC). Ownership: campaigns, leads, imports and activities
belong to the user who created them; a user only ever sees their own (owners/admins included).

## Health
- `GET /health` → `{ ok: true, driver: 'playwright' | 'simulated' }`

## Auth
- `POST /auth/signup` `{ name, email, password, inviteToken? }` → `201 AuthResponse`
  - password ≥ 8 chars; email unique (409). Without invite: creates a workspace named
    "<name>'s workspace" and the user is its `owner`. With a valid, unused, unexpired invite: joins that
    workspace with the invite's role; the invite's email must match (case-insensitive) else 400. An
    invalid, used or expired invite → 400 with `details.inviteToken`.
  - Creates default `UserSettings` (shared/time.ts `DEFAULT_SETTINGS`) and a `linkedin_accounts` row
    with status `disconnected`.
- `POST /auth/login` `{ email, password }` → `AuthResponse`; wrong credentials → 401 "Invalid email or password".
  Rate limit (failed attempts, sliding 15 min window, in memory) → 429:
  - 10 per (email, client IP);
  - 100 per client IP across all emails;
  - 100 per email across all IPs — not applied to an (email, IP) pair that signed in successfully in
    the last 30 days, so an attack from many addresses doesn't lock the owner out of a known device.

  The client IP is Express `req.ip`: `X-Forwarded-For` is honoured only for the proxy hops configured
  with `TRUST_PROXY` (default 1; `false` when the app is exposed directly). IPv6 addresses are
  grouped by /64; a value that is not an IP address counts as `"unknown"`.
- `POST /auth/logout` → `204` (deletes the session).
- `GET /auth/me` → `User`
- `PATCH /auth/me` `{ name }` → `User`
- `POST /auth/password` `{ currentPassword, newPassword }` → `204` (other sessions are revoked).
  Wrong current password → 400 with `details.currentPassword` (the session stays signed in); after 5
  wrong current passwords per user within 15 min → 429 (a correct one clears the count).
- `GET /auth/invite/:token` → `{ email, workspaceName, role }`, or 404 when the invite is invalid,
  used or expired (used by the signup page).

## Settings (active hours + random gap)
- `GET /settings` → `UserSettings`
- `PUT /settings` `UserSettings` → `UserSettings` (400 with `details` from `validateUserSettings`).
  `timezone` must pass `isValidTimeZone` (a zone `Intl.DateTimeFormat` accepts, e.g. an IANA name in
  any letter case such as `Asia/Kolkata`; at most 64 characters); it is stored as given, trimmed. `activeDays` are de-duplicated and sorted.

## LinkedIn account
- `GET /linkedin` → `LinkedInAccount`
- `POST /linkedin/login` `{ email, password }` → `LinkedInConnectResponse`
  (status `connected`, `needs_verification`, `needs_app_approval`, or 400/`error` with message).
  The password is used once to sign in and is never stored.
- `POST /linkedin/verify` `{ code }` → `LinkedInConnectResponse`
- `POST /linkedin/check` → `LinkedInConnectResponse` (poll while `needs_app_approval`)
- `POST /linkedin/cookie` `{ liAt }` → `LinkedInConnectResponse`
- `POST /linkedin/test` → `LinkedInTestResponse` (the **Test** button in Settings)
- `DELETE /linkedin` → `204` (forgets the session; campaigns stop sending until reconnected)

## Campaigns
- `GET /campaigns` → `CampaignSummary[]` (newest first)
- `POST /campaigns` `CreateCampaignInput` → `201 Campaign`
  - name 1–80 chars; settings validated (limits 0–200 / 0–300 / 0–300); sequence must pass
    `validateSequence` (shared/sequence.ts) — 400 with `details: { sequence: firstIssue }`.
  - `status: 'active'` additionally requires a non-empty sequence and (≥1 lead or ≥1 search import) → else 422.
  - leads are inserted with `insertLeads` (backend/src/engine/leads.ts); search imports create
    `lead_imports` rows (status `pending`), each URL must satisfy `isValidSearchUrl`, `max` 1–1000.
  - at most 5000 leads per request (413-ish → 400).
- `GET /campaigns/:id` → `Campaign`
- `PATCH /campaigns/:id` `UpdateCampaignInput` → `Campaign`
  - `sequence` may only change while status is not `active` → else 422
    "Pause the campaign before editing its sequence". After saving, call
    `reconcileLeads(db, campaignId, sequence, now)` (backend/src/engine/reconcile.ts).
  - `status` transitions: draft|paused|completed → active requires non-empty valid sequence and ≥1
    runnable lead or pending import (422 otherwise); active → paused; anything → draft is not allowed.
- `DELETE /campaigns/:id` → `204` (cascades leads/imports; activities keep their copied names).
- `GET /campaigns/:id/leads?status=<LeadStatus>&q=<text>&offset=0&limit=50` → `LeadsPage`
  (limit ≤ 200; q matches first/last name, company, headline; ordered by created_at, id).
- `POST /campaigns/:id/leads` `AddLeadsInput` → `AddLeadsResponse`
- `DELETE /campaigns/:id/leads` `{ ids: string[] }` → `204`
- `GET /campaigns/:id/activity?limit=100` → `Activity[]` (newest first, limit ≤ 500)

### CampaignStats (computed)
- totalLeads: leads in the campaign (all statuses)
- contacted: leads (still in the campaign) with at least one **successful** LinkedIn action, i.e. an
  activity with `status='success'` and `type` in `view_profile`, `follow`, `like_post`, `invite`,
  `message`, `withdraw`. Skipped steps (e.g. "not connected"), failures, evaluated conditions and
  detections (`accepted`, `replied`) don't count.
- invitesSent: leads with `invited_at` not null
- accepted: leads with `invited_at` and `connected_at` not null
- messagesSent: activities `type='message' AND status='success'`
- replied: leads with `replied_at` not null
- profileViews: activities `type='view_profile' AND status='success'`
- failed: leads with status `failed`

## Dashboard
- `GET /dashboard` → `Dashboard`
  - `today.*.done`: successful activities of that type (`invite`, `message`, `view_profile`) since local
    midnight in the user's time zone (`startOfDayInZone`); `limit`: sum of the matching daily limit
    over the user's **active** campaigns, capped at the engine's account-wide caps (100 / 150 / 250).
  - pendingInvites: leads with status `invited`; accepted / replies: as in CampaignStats, over all campaigns.
  - activity: latest 20 activities; campaigns: 5 most recently updated `CampaignSummary`.
  - `nextActionAt` / `withinActiveHours`: from the engine (`engine.nextActionAt(userId)`) and
    `isWithinActiveHours(now, settings)`.

## Team
- `GET /team` → `Team` (`invites`: pending, unexpired invites, newest first; empty for members)
- `POST /team/invites` `{ email, role: 'admin'|'member' }` → `201 TeamInvite` (owner/admin only; 409 if
  the email already belongs to a user). `url` = `${PUBLIC_APP_URL}/signup?invite=<token>` (or relative).
  An invite link works once and expires 7 days after `createdAt`; a new invite for the same email
  replaces the pending one.
- `DELETE /team/invites/:token` → `204` (owner/admin)
- `PATCH /team/members/:id` `{ role: 'admin'|'member' }` → `TeamMember` (owner only; cannot change owner).
  Demoting to `member` deletes the pending invites that user created.
- `DELETE /team/members/:id` → `204` (owner/admin; cannot remove the owner or yourself;
  the removed user and all their campaigns, leads and LinkedIn session are deleted, and so are the
  pending invites they created)
