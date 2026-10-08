# Engine (contract)

The engine runs inside the API process. It reads due work from SQLite and performs it through
`LinkedInService.withDriver(userId, fn)`. Everything is persisted, so a restart resumes where it left off.

## Modules (backend/src/engine/)
- `leads.ts` — `insertLeads(...)` (shared with the API and search imports). Invalid URLs and duplicates
  within the campaign are dropped (counted as skipped). With `skipOtherCampaigns`, a person (same
  `public_id`) who is a non-terminal lead (status not finished/skipped/failed) in another campaign of
  the same user whose status is `active`, `paused` or `draft` is stored with status `skipped`,
  `current_step_id`/`next_action_at` NULL, `last_action = 'Skipped'`, error `Already in campaign “<name>”`
  (counted as skipped). Other leads start `queued` at the root with the root step's random delay.
- `reconcile.ts` — `reconcileLeads(db, campaignId, sequence, now)`: after a sequence edit, for every
  non-terminal lead (status not in finished/skipped/failed) whose `current_step_id` is null or no longer
  exists in the sequence: if the lead has never been acted on (`last_action_at IS NULL`) move it to the
  root (`current_step_id = rootId`, `next_action_at = step_started_at = now + pickDelayMs(root.delay)`;
  if the sequence is empty set both to NULL); otherwise mark it `finished` with `next_action_at = NULL`.
  Leads whose current step still exists are untouched. A lead whose step is running on LinkedIn during
  the edit still looks "never acted on" and is moved to the root; see "Results that arrive after a
  sequence edit" below for how its result is then written.
- `engine.ts` — `createEngine({ db, linkedin, tickMs, now?, rand? }): Engine`
  ```ts
  interface Engine {
    start(): void            // setInterval(tick, tickMs); never two ticks at once
    stop(): void
    tick(): Promise<void>    // one pass over all users; awaitable for tests (waits for started work)
    nextActionAt(userId: string): number | null   // for the dashboard
  }
  ```
  `now` (default `Date.now`) and `rand` (default `Math.random`) are injectable for tests.

## Tick
For each user that has `linkedin_accounts.status = 'connected'` and at least one `active` campaign
(accounts that are `expired` — session_expired — or `error` — account_problem — get no work until the
user reconnects or successfully tests the account, which sets `connected` again):
1. Skip if `!isWithinActiveHours(now, settings)` (shared/time.ts, settings from `user_settings`).
2. Skip if `linkedin_accounts.next_action_at > now` (the random gap) or the user already has work running.
3. Do **one unit of LinkedIn work** for the user (below), inside `linkedin.withDriver(userId, …)`.
4. After any unit that touched LinkedIn (success *or* failure) set
   `linkedin_accounts.next_action_at = now + random(gapMinMinutes, gapMaxMinutes) minutes`
   — this is the "random 1–5 minutes between actions". A `transient` failure extends it to a 10–20 min
   back-off (see Failures).
Users are processed independently (one slow user must not block others); a user never has two units
in flight. Unexpected exceptions are caught and logged; the loop never dies.

### Choosing the unit of work (per user)
1. Search imports first: the oldest `lead_imports` row with status `pending`/`running` whose campaign
   is `active` → fetch one results page (see Imports).
2. Otherwise the due lead with the smallest `next_action_at` among the user's `active` campaigns where
   `next_action_at <= now` and status not in (`finished`,`skipped`,`failed`).
   - Steps that do not touch LinkedIn (`end`, or a missing step) are resolved immediately and the
     engine keeps looking for a LinkedIn unit in the same tick (bounded loop, e.g. 25 iterations).
   - **skipOtherCampaigns, before the first LinkedIn action**: when the campaign has
     `skipOtherCampaigns` and the lead has never been acted on (`last_action_at IS NULL`), and the same
     `public_id` is a non-terminal lead that has already been acted on (`last_action_at IS NOT NULL`) in
     another `active` or `paused` campaign of the user → the lead becomes `skipped` without any LinkedIn
     call: `current_step_id`/`next_action_at` NULL, `last_action = 'Skipped'`, error and an activity
     (type = the step kind, status `skipped`) "Already being contacted by campaign “<name>”". This catches
     overlaps the insert-time check could not see (e.g. a campaign whose copy of the lead was added
     with the setting off, or two campaigns started at the same time); whichever campaign acts first
     keeps the person. Checked before throttles and daily limits.
   - **Daily limits** (per campaign, counted from successful activities since `startOfDayInZone(now, tz)`):
     `invite` ↔ `dailyInvites`, `message` ↔ `dailyMessages`, `view_profile` ↔ `dailyProfileViews`.
     Also hard account-wide caps per day across all campaigns: 100 invites, 150 messages, 250 profile views.
     If a limit is reached, postpone the lead to `nextActiveTime(start of tomorrow in tz)` and keep looking.

## Steps
Messages and invite notes are personalised with `renderTemplate(text, { first_name, last_name,
company, title: headline, location })` and clipped (at a word boundary when possible) to 300
characters for invite notes and 8000 for messages. When the text uses a variable the lead has no value
for (or the name was only guessed from the URL), the step first reads the profile (`viewProfile`) and
fills the empty lead fields — also when the step then fails, so a retry renders the same text. The
rendered text is a pure function of the step and the lead's fields, so a retry of a message step
passes exactly the same text (needed for message idempotency, below). Lead status only moves "up":
`queued < in_progress < invited < connected < replied` (never downgrade; terminal statuses are set
explicitly). Every executed step sets `last_action`, `last_action_at = now`, clears `error`, resets
`attempts = 0`, and records an activity row (with copied `campaign_name`, `lead_name` = "First Last").

| step | driver call | result handling |
|---|---|---|
| `view_profile` | `viewProfile` | fill empty lead fields (name/headline/company/location) from the result; if `connection === 'connected'` set `connected_at` (if null) and status ≥ connected. activity `view_profile` success |
| `follow` | `follow` | activity `follow` success (`already_following` → status `skipped`) |
| `like_post` | `likeLatestPost` | activity `like_post`; `no_posts`/`already_liked` → `skipped` |
| `invite` | `sendInvite(url, note or null)` | `sent`/`sent_without_note` → `invited_at = now`, status ≥ invited, activity `invite` success; detail "Invite sent with a note", "Invite sent with a note (shortened to 300 characters)" (the personalised note was longer than 300 characters and was clipped), "Invite sent without a note", or "Invite sent without a note (LinkedIn did not allow one)". `already_connected` → `connected_at` = now if null (activity `accepted` if the lead was invited and `connected_at` was null), then: with `skipConnected` **true** and an existing connection (this campaign has not invited the lead — `invited_at` NULL —, not messaged it — `last_message_text` NULL — and it is not `replied`) the lead leaves the campaign: status `skipped`, `current_step_id`/`next_action_at` NULL, `last_action = 'Already a connection – skipped'`, activity `invite` skipped "Already connected – lead skipped". Otherwise (`skipConnected` false, or a lead this campaign invited who has accepted) status ≥ connected, `last_action = 'Already connected'`, activity `invite` skipped "Already connected", and the sequence continues. `pending` → `invited_at` = now if null, status ≥ invited, activity skipped "Invite already pending". |
| `message` | `sendMessage(url, text, opts)` — `opts = {}` for the campaign's first message to the lead (`last_message_text IS NULL`) or without `stopOnReply`; otherwise `{ stopIfRepliedAfter: { after: lead.last_message_text } }` | `sent` / `already_sent` → the message was delivered, which proves a 1st-degree connection: `connected_at` = now if null (activity `accepted` if the lead had been invited), status ≥ connected; `last_message_text` = the text sent (also when the lead moved meanwhile); activity `message` success "Message sent" or, for `already_sent`, "Message was already delivered by an earlier attempt". `replied` → set `replied_at`, status `replied`, activity `replied` success "Replied on LinkedIn – message not sent", and (stopOnReply) finish the lead. `not_connected` → activity `message` skipped "Not a 1st-degree connection", continue |
| `withdraw` | `withdrawInvite` | `withdrawn` → activity success; `not_pending` → skipped |
| `condition` | see below | |
| `end` | — | status `finished` (keep `replied` if already replied), `next_action_at = NULL` |

After a step completes, advance: `next = nextStepId(step, outcome)`. No next (or a next id that is not
in the sequence) → finish the lead (`finished`, or keep `replied`; `current_step_id = NULL`,
`next_action_at = NULL`). Otherwise `current_step_id = next`,
`next_action_at = step_started_at = now + pickDelayMs(nextStep.delay, rand)`.

### Replies
A reply only counts if the lead wrote **after the campaign's last message to them**
(`leads.last_message_text`, set whenever a message step results in `sent` or `already_sent`). The
driver gets a `ReplyCheck { after: last_message_text }`; with `after: null` only messages by the lead
after our most recent own message in the thread count, so older conversation history from before the
campaign is never a reply. The first message of a campaign to a lead is sent without a reply check.
With `stopOnReply` on, a detected reply finishes the lead — from a message step and from an
"If replied" condition alike, so the Yes branch of an "If replied" condition only runs when
`stopOnReply` is off (the builder warns about this).

### Message idempotency (retries, restarts)
`sendMessage` is idempotent: when the 1:1 thread already ends with our own message with the same text
(whitespace-normalised) it sends nothing and returns `already_sent`, which the engine treats like `sent`
(see the table). A message step that fails after LinkedIn delivered it (e.g. the send could not be
confirmed, or the browser was closed by a shutdown mid-send — a failure caused by `stop()` is discarded
and the lead stays due with unchanged attempts) is retried with exactly the same text, so the retry
finds it and records it once instead of sending a second copy.

### Results that arrive after a sequence edit
Results are written to the lead as re-read when the step finishes (it may have been paused, edited or
deleted meanwhile). Normally the lead only moves (advance / finish / skip) when it is still on the step
that ran. Exception: a sequence edit removed the step while it ran and `reconcileLeads` moved the lead,
which had not been acted on yet, to the new root. When that step then ran (any result written through
the step table, or `action_unavailable`), the lead is placed as if its result had been saved before the
edit: it continues at the old step's next step if that step is in the new sequence, otherwise it is
finished. So it never gets the new root as a second first action (e.g. a corrected message after the
original). A failure that is retried (nothing recorded), and a condition that answered No or "not yet"
(a read-only check), leave the re-rooted lead at the new root.

### Conditions
- `accepted_invite` / `is_connected`: `getConnectionStatus(url) === 'connected'`. When true and the lead
  was invited and `connected_at` is null: set `connected_at`, status ≥ connected, activity `accepted` success.
- `replied`: `hasReplied(url, { after: lead.last_message_text })` (see Replies). When true:
  `replied_at`, status `replied`, activity `replied` success; if the campaign has `stopOnReply`,
  finish the lead instead of following the Yes branch.
- Outcome: true → Yes branch. False and `now - step_started_at >= durationToMs(within)` → No branch
  (activity `condition` success "…: No"). False otherwise → re-check later:
  `next_action_at = min(step_started_at + within, now + clamp(within / 6, 2 min, 4 h) ± 20 %)`; no
  activity row for intermediate checks (but it counts as a LinkedIn unit for the gap).
- Resolution writes an activity `condition` success with detail "<question>: Yes|No".

## Failures (`LinkedInError.code`)
- `session_expired` → set `linkedin_accounts.status = 'expired'`, `last_error`; activity `session` failed;
  the lead is **not** penalised (attempts unchanged, still due). Engine skips the user until reconnected.
- `account_problem` (the LinkedIn account needs the user's attention, e.g. interface language, restricted)
  → `linkedin_accounts.status = 'error'`, `last_error` = message (only if the account is still
  `connected`/`error`: a disconnect or reconnect meanwhile wins); activity `session` failed with the
  message; the lead is untouched. Engine skips the user until they reconnect / test successfully.
- `transient` (no network, `net::ERR_*`, browser failed to launch or crashed, navigation timeouts) → not
  the lead's fault: no attempt is counted and the lead stays due; the whole user backs off:
  `linkedin_accounts.next_action_at = now + random(10, 20) min` (never shortening a later gap); one
  activity `session` failed with the message. The lead's `next_action_at` becomes the end of that
  back-off (if earlier), so it is still due then but leads that were already waiting go first — one
  lead whose page keeps failing cannot hold up the others. A long outage never fails leads.
- `rate_limited` → activity failed with the message; postpone the lead to the next day's active window.
- `not_found` → lead `failed` with error "Profile not found", `next_action_at = NULL`, activity failed.
- `action_unavailable` → activity skipped with the message; advance to the next step (the step can't be done).
- anything else → `attempts += 1`, activity failed; `attempts >= 3` → lead `failed` (error = message,
  `next_action_at = NULL`); else retry at `now + attempts × random(15, 30) min`.

## Imports (people-search URLs)
Process `searchPeople(url, page)`: insert the people with `insertLeads` (listName = import list name),
`collected += added`, `page += 1`, status `running`; activity `import` success "Collected N leads (page P)".
Done when `!hasMore` or `collected >= max_leads` or `page > 100` → status `done`. Errors:
`session_expired` and `account_problem` as above (the import is not penalised); `transient` → no
attempt counted, user back-off and `session` activity as above, and searches then wait another random
10–20 min after the back-off so leads go first (imports are otherwise always picked before leads);
`rate_limited` → searches wait until the next day's window; other errors `attempts += 1`, ≥ 3 → status
`failed` with error.

## Campaign completion
At the end of each user's pass: an `active` campaign with ≥ 1 lead, no pending/running imports and no
lead with `next_action_at IS NOT NULL` → status `completed`.
