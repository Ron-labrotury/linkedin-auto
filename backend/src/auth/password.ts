import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/** scrypt parameters for new hashes. Stored with each hash, so they can be raised later. */
const N = 16384
const R = 8
const P = 1
const KEY_LEN = 64
const MAX_MEM = 64 * 1024 * 1024

function derive(password: string, salt: Buffer, n: number, r: number, p: number, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLen, { N: n, r, p, maxmem: MAX_MEM }, (err, key) => (err ? reject(err) : resolve(key)))
  })
}

/** "scrypt$N$r$p$saltB64$hashB64" */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(password, salt, N, R, P, KEY_LEN)
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [n, r, p] = parts.slice(1, 4).map(Number)
  if (!Number.isSafeInteger(n) || n < 2 || n > 1 << 20 || (n & (n - 1)) !== 0) return false
  if (!Number.isSafeInteger(r) || r < 1 || r > 32 || !Number.isSafeInteger(p) || p < 1 || p > 16) return false
  const salt = Buffer.from(parts[4], 'base64')
  const expected = Buffer.from(parts[5], 'base64')
  if (!salt.length || expected.length < 16 || expected.length > 256) return false
  try {
    const key = await derive(password, salt, n, r, p, expected.length)
    return timingSafeEqual(key, expected)
  } catch {
    return false
  }
}

let dummy: Promise<string> | null = null
/** A real hash of a random password: verifying against it costs the same as a real check (no user enumeration by timing). */
export const dummyHash = () => (dummy ??= hashPassword(randomBytes(18).toString('base64')))
