import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrations } from './schema.ts'

export type DB = DatabaseSync

/** Open (and migrate) the SQLite database. Pass ":memory:" for tests. */
export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  migrate(db)
  return db
}

function migrate(db: DB) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let v = current; v < migrations.length; v++) {
    tx(db, () => {
      db.exec(migrations[v])
      db.exec(`PRAGMA user_version = ${v + 1}`)
    })
  }
}

/** Run `fn` in a transaction (nested calls join the outer transaction). */
export function tx<T>(db: DB, fn: () => T): T {
  if (db.isTransaction) return fn()
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** Typed single-row query. */
export function one<T>(db: DB, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined
}

/** Typed multi-row query. */
export function all<T>(db: DB, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[]
}

export function run(db: DB, sql: string, ...params: unknown[]) {
  return db.prepare(sql).run(...(params as never[]))
}

export const toIso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString())
