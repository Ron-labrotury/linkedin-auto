import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { config } from './config.ts'

/** AES-256-GCM with a key derived from APP_SECRET. Format: "v1.<iv>.<tag>.<ciphertext>" (base64url). */
const key = createHash('sha256').update(`linkedin-auto:${config.appSecret}`).digest()

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.')
}

/** Returns null when the value can't be decrypted (e.g. APP_SECRET changed). */
export function decrypt(payload: string): string | null {
  try {
    const [v, iv, tag, ct] = payload.split('.')
    if (v !== 'v1') return null
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
