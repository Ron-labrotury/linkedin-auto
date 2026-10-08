/** Epoch ms → ISO string (for non-null columns; use db `toIso` for nullable ones). */
export const iso = (ms: number) => new Date(ms).toISOString()

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

/**
 * Structural equality for JSON-like values. Key order is ignored, and an object key holding
 * null/undefined counts as absent (a sequence step's `next: null` equals no `next`).
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => jsonEqual(x, (b as unknown[])[i]))
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const ka = Object.keys(ra).filter((k) => ra[k] != null)
  const kb = Object.keys(rb).filter((k) => rb[k] != null)
  if (ka.length !== kb.length) return false
  return ka.every((k) => jsonEqual(ra[k], rb[k]))
}
