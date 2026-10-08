import type { Request } from 'express'

/** The parsed JSON body, or `{}` when the request had none. */
export const body = (req: Request): unknown => req.body ?? {}

/** Query string as flat strings: repeated keys keep the first value, empty values are dropped. */
export function query(req: Request): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.query ?? {})) {
    const first = Array.isArray(v) ? v[0] : v
    if (typeof first === 'string' && first !== '') out[k] = first
  }
  return out
}

/** True for SQLite UNIQUE / PRIMARY KEY violations (concurrent inserts racing a pre-check). */
export const isUniqueViolation = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/.test(e.message)
