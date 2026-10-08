import { randomBytes } from 'node:crypto'

/** Random URL-safe id with a readable prefix, e.g. "cmp_3k9x…". */
export const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString('base64url')}`

/** High-entropy secret token (sessions, invites). */
export const newToken = () => randomBytes(32).toString('base64url')
