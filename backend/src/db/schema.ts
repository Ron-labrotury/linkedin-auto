/**
 * Database migrations. Each entry runs once, in order, tracked by PRAGMA user_version.
 * Append new migrations; never edit a released one.
 *
 * Conventions: ids are TEXT (see ids.ts), times are INTEGER epoch milliseconds (UTC),
 * JSON blobs are TEXT columns suffixed _json.
 */
export const migrations: string[] = [
  /* 1 — initial schema */ `
  CREATE TABLE workspaces (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX users_workspace ON users(workspace_id);

  -- Bearer tokens; only the SHA-256 of the token is stored.
  CREATE TABLE sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE invites (
    token         TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email         TEXT NOT NULL COLLATE NOCASE,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at    INTEGER NOT NULL,
    accepted_at   INTEGER
  );

  CREATE TABLE user_settings (
    user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    timezone         TEXT NOT NULL,
    active_days_json TEXT NOT NULL,          -- JSON number[] (0 = Sunday)
    active_start     TEXT NOT NULL,          -- "HH:MM"
    active_end       TEXT NOT NULL,          -- "HH:MM"
    gap_min_minutes  REAL NOT NULL,
    gap_max_minutes  REAL NOT NULL,
    updated_at       INTEGER NOT NULL
  );

  -- One LinkedIn account per user. The Playwright storage state (cookies) is stored
  -- encrypted; the LinkedIn password is never stored.
  CREATE TABLE linkedin_accounts (
    user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    status           TEXT NOT NULL,          -- LinkedInStatus
    auth_method      TEXT,                   -- 'password' | 'cookie'
    email            TEXT,
    session_enc      TEXT,                   -- crypto.encrypt(JSON storageState)
    profile_json     TEXT,                   -- LinkedInProfile
    last_checked_at  INTEGER,
    last_error       TEXT,
    next_action_at   INTEGER,                -- engine: earliest time of the next LinkedIn action (random gap)
    updated_at       INTEGER NOT NULL
  );

  CREATE TABLE campaigns (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'completed')),
    sequence_json  TEXT NOT NULL,            -- Sequence
    settings_json  TEXT NOT NULL,            -- CampaignSettings
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );
  CREATE INDEX campaigns_user ON campaigns(user_id, status);

  CREATE TABLE leads (
    id               TEXT PRIMARY KEY,
    campaign_id      TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_id        TEXT NOT NULL,          -- linkedin.com/in/<public_id>, lower-cased
    profile_url      TEXT NOT NULL,          -- normalized
    first_name       TEXT NOT NULL DEFAULT '',
    last_name        TEXT NOT NULL DEFAULT '',
    headline         TEXT NOT NULL DEFAULT '',
    company          TEXT NOT NULL DEFAULT '',
    location         TEXT NOT NULL DEFAULT '',
    list_name        TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL,          -- LeadStatus
    current_step_id  TEXT,                   -- step to run next (null when done or sequence empty)
    step_started_at  INTEGER,                -- when the current step became due (condition timeout base)
    next_action_at   INTEGER,                -- due time of current step; NULL = nothing scheduled
    attempts         INTEGER NOT NULL DEFAULT 0,  -- consecutive failures of the current step
    invited_at       INTEGER,
    connected_at     INTEGER,
    replied_at       INTEGER,
    last_action      TEXT,                   -- human readable, e.g. "Invite sent"
    last_action_at   INTEGER,
    error            TEXT,
    created_at       INTEGER NOT NULL,
    UNIQUE (campaign_id, public_id)
  );
  CREATE INDEX leads_due ON leads(user_id, next_action_at) WHERE next_action_at IS NOT NULL;
  CREATE INDEX leads_campaign ON leads(campaign_id, status);
  CREATE INDEX leads_public ON leads(user_id, public_id);

  -- LinkedIn people-search URLs whose results are collected in the background.
  CREATE TABLE lead_imports (
    id           TEXT PRIMARY KEY,
    campaign_id  TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url          TEXT NOT NULL,
    max_leads    INTEGER NOT NULL,
    collected    INTEGER NOT NULL DEFAULT 0,
    page         INTEGER NOT NULL DEFAULT 1,  -- next results page to fetch (1-based)
    attempts     INTEGER NOT NULL DEFAULT 0,
    status       TEXT NOT NULL,               -- ImportStatus
    list_name    TEXT NOT NULL DEFAULT '',
    error        TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX imports_campaign ON lead_imports(campaign_id, status);

  -- Everything the engine does (and detects). Names are copied so the feed survives deletes.
  CREATE TABLE activities (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    campaign_id    TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
    campaign_name  TEXT,
    lead_id        TEXT REFERENCES leads(id) ON DELETE SET NULL,
    lead_name      TEXT,
    step_id        TEXT,
    type           TEXT NOT NULL,            -- ActivityType
    status         TEXT NOT NULL CHECK (status IN ('success', 'failed', 'skipped')),
    detail         TEXT NOT NULL DEFAULT '',
    created_at     INTEGER NOT NULL
  );
  CREATE INDEX activities_user_time ON activities(user_id, created_at DESC);
  CREATE INDEX activities_campaign ON activities(campaign_id, type, status, created_at);
  `,
  /* 2 — reply detection relative to our last message; invite expiry */ `
  ALTER TABLE leads ADD COLUMN last_message_text TEXT;   -- rendered text of the last message sent to the lead
  ALTER TABLE invites ADD COLUMN expires_at INTEGER;      -- NULL for invites created before this migration
  `,
]
