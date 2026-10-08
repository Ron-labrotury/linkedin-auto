import { Router } from 'express'
import { z } from 'zod'
import type { LinkedInConnectResponse, LinkedInTestResponse } from '../../../shared/types.ts'
import { HttpError } from '../http/errors.ts'
import { body } from '../http/request.ts'
import type { AppDeps } from '../http/types.ts'
import { auth } from '../auth/middleware.ts'
import type { ConnectOutcome } from '../linkedin/types.ts'

const loginSchema = z.object({
  email: z.string('Enter your LinkedIn email').trim().min(1, 'Enter your LinkedIn email').max(254, 'Email is too long'),
  password: z.string('Enter your LinkedIn password').min(1, 'Enter your LinkedIn password').max(1000, 'Password is too long'),
})

const codeSchema = z.object({
  code: z
    .string('Enter the verification code')
    .transform((s) => s.replace(/\s+/g, ''))
    .pipe(z.string().regex(/^\d{4,10}$/, 'Enter the 4–10 digit code LinkedIn sent you')),
})

/** Accepts the bare cookie value, or a pasted "li_at=…;" / quoted value. */
const cookieSchema = z.object({
  liAt: z
    .string('Paste your li_at cookie')
    .transform((s) =>
      s
        .trim()
        .replace(/^li_at\s*=\s*/i, '')
        .replace(/;$/, '')
        .replace(/^"(.*)"$/, '$1')
        .trim(),
    )
    .pipe(z.string().min(10, 'That li_at cookie looks too short').max(4000, 'That li_at cookie is too long')),
})

const connectResponse = (o: ConnectOutcome): LinkedInConnectResponse => ({ account: o.account, message: o.message })

export function linkedinRouter({ linkedin }: AppDeps) {
  const r = Router()

  /** Service failures become 400 with the service's message. Inputs (passwords, cookies) are never logged. */
  async function call<T>(op: string, userId: string, fn: () => Promise<T> | T): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      const message = e instanceof Error && e.message ? e.message : 'LinkedIn request failed'
      console.warn(`[linkedin] ${op} failed for user ${userId}: ${message}`)
      throw new HttpError(400, message)
    }
  }

  r.get('/', async (req, res) => {
    const { user } = auth(req)
    res.json(await call('getAccount', user.id, () => linkedin.getAccount(user.id)))
  })

  r.post('/login', async (req, res) => {
    const { email, password } = loginSchema.parse(body(req))
    const { user } = auth(req)
    res.json(connectResponse(await call('login', user.id, () => linkedin.loginWithPassword(user.id, email, password))))
  })

  r.post('/verify', async (req, res) => {
    const { code } = codeSchema.parse(body(req))
    const { user } = auth(req)
    res.json(connectResponse(await call('verify', user.id, () => linkedin.submitVerificationCode(user.id, code))))
  })

  r.post('/check', async (req, res) => {
    const { user } = auth(req)
    res.json(connectResponse(await call('check', user.id, () => linkedin.checkPendingLogin(user.id))))
  })

  r.post('/cookie', async (req, res) => {
    const { liAt } = cookieSchema.parse(body(req))
    const { user } = auth(req)
    res.json(connectResponse(await call('cookie', user.id, () => linkedin.connectWithCookie(user.id, liAt))))
  })

  r.post('/test', async (req, res) => {
    const { user } = auth(req)
    const out = await call('test', user.id, () => linkedin.test(user.id))
    res.json({ ok: out.ok, message: out.message, account: out.account } satisfies LinkedInTestResponse)
  })

  r.delete('/', async (req, res) => {
    const { user } = auth(req)
    await call('disconnect', user.id, () => linkedin.disconnect(user.id))
    res.status(204).end()
  })

  return r
}
