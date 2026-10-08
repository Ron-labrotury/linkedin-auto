/** In-memory database with users, for the LinkedIn service tests. */
import { type DB, openDb, run } from '../../src/db/index.ts'
import { config } from '../../src/config.ts'
import type { Config } from '../../src/config.ts'

let n = 0

export function addUser(db: DB, opts: { withAccountRow?: boolean; timezone?: string } = {}) {
  const id = `usr_test_${++n}`
  const ws = `ws_test_${n}`
  const now = Date.now()
  run(db, 'INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', ws, 'Test workspace', now)
  run(db, `INSERT INTO users (id, workspace_id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'x', 'owner', ?)`, id, ws, `${id}@example.com`, 'Tester', now)
  if (opts.timezone) {
    run(
      db,
      `INSERT INTO user_settings (user_id, timezone, active_days_json, active_start, active_end, gap_min_minutes, gap_max_minutes, updated_at)
       VALUES (?, ?, '[1,2,3,4,5]', '09:00', '18:00', 1, 5, ?)`,
      id,
      opts.timezone,
      now,
    )
  }
  if (opts.withAccountRow !== false) {
    run(db, `INSERT INTO linkedin_accounts (user_id, status, updated_at) VALUES (?, 'disconnected', ?)`, id, now)
  }
  return id
}

export function testDb() {
  return openDb(':memory:')
}

/** The app config with fast simulated timings. */
export function simConfig(sim: Partial<Config['sim']> = {}): Config {
  return { ...config, linkedinDriver: 'simulated', sim: { acceptAfterMs: 40, replyAfterMs: 60, actionLatencyMs: 0, ...sim } }
}
