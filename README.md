# linkedin-auto (LinkPilot)

LinkedIn outreach automation, Dripify-style. Users connect their own LinkedIn account, build their own
sequence (invite → if accepted → message → if no reply → follow-up …), add leads and launch campaigns.
A server-side engine runs every step in a real headless browser, inside the user's **active hours**,
with a **random pause (default 1–5 minutes)** between actions and per-campaign daily limits.

```
frontend/   React + Vite + Tailwind UI (deployable on Vercel)
backend/    Node 22 API + automation engine + Playwright LinkedIn driver + SQLite
shared/     Types and logic used by both (sequence model, active-hours math, URL parsing)
docs/       API.md (HTTP API) and ENGINE.md (how the scheduler behaves)
```

## Run it locally

Requires **Node 22.18+** (the backend runs TypeScript directly and uses the built-in `node:sqlite`).

```bash
# 1. backend (http://localhost:8787)
cd backend
npm install
npx playwright install chromium     # once, for the real LinkedIn driver
npm run dev                          # real LinkedIn
# or: npm run dev:simulated          # fake LinkedIn – try every flow without touching your account

# 2. frontend (http://localhost:5173, proxies /api to the backend)
cd ../frontend
npm install
npm run dev
```

Open http://localhost:5173, create an account, and you land on **Connect your LinkedIn account**.

### Connecting LinkedIn
- **Email & password** – the server signs in once in a headless browser. If LinkedIn asks for a code
  (email/SMS/authenticator) or an approval in the LinkedIn app, the UI asks for it. The password is
  never stored; only the encrypted browser session is.
- **Session cookie** – paste the `li_at` cookie from a browser where you're logged in
  (linkedin.com → DevTools → Application → Cookies → `li_at`). Use this if LinkedIn shows a captcha.
- **Settings → Test connection** checks the stored session at any time.

### Simulated mode (`LINKEDIN_DRIVER=simulated`)
Any email connects (`…+code@…` asks for code `123456`, `…+app@…` simulates app approval). Profile URLs
containing `accepter`, `replier`, `connected`, `notfound`, `ratelimit` or `flaky` force those outcomes,
and `SIM_ACCEPT_AFTER_MS` / `SIM_REPLY_AFTER_MS` control how fast people "accept" and "reply".

### Tests
```bash
cd backend && npm run typecheck && npm test
cd frontend && npx tsc --noEmit && npm test
```

## How campaigns run
- Steps: view profile, follow, like latest post, send invite (optional 300-char note), send message,
  withdraw invite, and conditions **If invite accepted / If connected / If replied** with a
  "keep checking for up to …" window (Yes / No branches). Messages support `{{first_name}}`,
  `{{last_name}}`, `{{company}}`, `{{title}}`, `{{location}}`.
- Every step has its own random wait ("between 1 and 5 minutes", hours or days), picked per lead.
- Across all campaigns of a user, LinkedIn actions run one at a time, only inside the active hours set
  in **Settings → Active hours**, with a random pause (min–max minutes) after each action.
- Daily limits per campaign plus account-wide caps (100 invites, 150 messages, 250 profile views a day).
- "Stop on reply" ends a lead's sequence once they reply; leads already connected skip the invite.
- Everything is stored in SQLite (`DATA_DIR/app.db`), so a restart resumes where it left off.

> Automating LinkedIn is against LinkedIn's User Agreement and can get an account restricted.
> Keep limits conservative and keep the random pauses.

## Deploy

The backend runs a real browser and a long-running scheduler, so it **cannot run on Vercel**.
Host it on any Docker platform with a persistent disk; the frontend can stay on Vercel or be served
by the backend.

### Everything in one container (simplest)
`Dockerfile` builds the frontend and serves it from the backend, with Chromium included.
- **Render:** New → Blueprint → this repo (`render.yaml` creates the service, a 1 GB disk at `/data`
  and a random `APP_SECRET`).
- **Railway / Fly.io / a VPS:** build the Dockerfile, mount a volume at `/data`, set `APP_SECRET`
  (any long random string – it encrypts stored LinkedIn sessions).

### Frontend on Vercel + backend elsewhere
1. Deploy the backend as above and note its URL, e.g. `https://linkedin-auto.onrender.com`.
2. In the Vercel project set the environment variable `VITE_API_URL` to that URL and redeploy
   (`vercel.json` already builds `frontend/`).
3. On the backend set `CORS_ORIGIN` to your Vercel URL and `PUBLIC_APP_URL` to it as well
   (used for team invite links).

### Backend environment variables
See `backend/.env.example`: `APP_SECRET` (required in production), `PORT`, `DATA_DIR`, `CORS_ORIGIN`,
`LINKEDIN_DRIVER` (`playwright` | `simulated`), `HEADLESS`, `PUBLIC_APP_URL`, `TRUST_PROXY`,
`MAX_BROWSER_CONTEXTS` (open Chromium sessions at once, default 3 – each needs ~150–300 MB), `ENGINE_TICK_MS`.
