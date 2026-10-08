/** A scriptable LinkedInService / driver for the engine tests. */
import type { LinkedInAccount } from '../../../shared/types.ts'
import { nameFromPublicId, publicIdFromUrl } from '../../../shared/linkedin-url.ts'
import {
  type ConnectOutcome,
  LinkedInError,
  type LinkedInDriver,
  type LinkedInService,
  type MessageResult,
  type ProfileData,
  type ReplyCheck,
} from '../../src/linkedin/types.ts'

export type DriverMethod = keyof LinkedInDriver

export interface DriverCall {
  userId: string
  method: DriverMethod
  args: unknown[]
}

/** A response: a value, an Error (thrown), a promise (awaited) or a function of the call args. */
export type Response = unknown

export interface Deferred<T> {
  promise: Promise<T>
  resolve(v: T): void
  reject(e: unknown): void
}

export function deferred<T = unknown>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Resolves once `cond()` holds (polling the event loop), or throws after ~2 s. */
export async function until(cond: () => boolean, what = 'condition') {
  for (let i = 0; i < 400; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const defaults: Record<DriverMethod, (...args: any[]) => unknown> = {
  viewProfile: (url: string): ProfileData => {
    const id = publicIdFromUrl(url) ?? 'unknown'
    const n = nameFromPublicId(id)
    return { firstName: n.firstName, lastName: n.lastName, headline: '', company: '', location: '', profileUrl: url, connection: 'not_connected' }
  },
  getConnectionStatus: () => 'not_connected',
  sendInvite: () => 'sent',
  sendMessage: (_url: string, _text: string, _opts: { stopIfRepliedAfter?: ReplyCheck }): MessageResult => 'sent',
  hasReplied: (_url: string, _check: ReplyCheck) => false,
  follow: () => 'followed',
  likeLatestPost: () => 'liked',
  withdrawInvite: () => 'withdrawn',
  searchPeople: () => ({ people: [], hasMore: false }),
}

export const linkedInError = (code: LinkedInError['code'], message = `simulated ${code}`) => new LinkedInError(code, message)

export class FakeLinkedIn implements LinkedInService {
  readonly kind = 'simulated' as const
  readonly calls: DriverCall[] = []
  /** userIds in the order withDriver was entered */
  readonly sessions: string[] = []
  /** users whose session withDriver rejects with session_expired */
  readonly expired = new Set<string>()
  private readonly queues = new Map<string, Response[]>()
  private readonly handlers = new Map<string, (...args: any[]) => unknown>()

  /** Responses for the next calls of `method` (any user). */
  queue(method: DriverMethod, ...responses: Response[]) {
    this.queueFor('*', method, ...responses)
    return this
  }

  /** Responses for the next calls of `method` by one user (checked before the any-user queue). */
  queueFor(userId: string, method: DriverMethod, ...responses: Response[]) {
    const key = `${userId}|${method}`
    this.queues.set(key, [...(this.queues.get(key) ?? []), ...responses])
    return this
  }

  /** Default behaviour of `method` once the queues are empty. */
  handle(method: DriverMethod, fn: (...args: any[]) => unknown) {
    this.handlers.set(method, fn)
    return this
  }

  callsOf(method: DriverMethod, userId?: string) {
    return this.calls.filter((c) => c.method === method && (!userId || c.userId === userId))
  }

  private async respond(userId: string, method: DriverMethod, args: unknown[]) {
    this.calls.push({ userId, method, args })
    const own = this.queues.get(`${userId}|${method}`)
    const any = this.queues.get(`*|${method}`)
    let r: Response
    if (own?.length) r = own.shift()
    else if (any?.length) r = any.shift()
    else r = (this.handlers.get(method) ?? defaults[method])(...args)
    if (typeof r === 'function') r = (r as (...a: unknown[]) => unknown)(...args)
    r = await r
    if (r instanceof Error) throw r
    return r
  }

  driverFor(userId: string): LinkedInDriver {
    const call =
      (method: DriverMethod) =>
      (...args: unknown[]) =>
        this.respond(userId, method, args) as Promise<never>
    return {
      viewProfile: call('viewProfile'),
      getConnectionStatus: call('getConnectionStatus'),
      sendInvite: call('sendInvite'),
      sendMessage: call('sendMessage'),
      hasReplied: call('hasReplied'),
      follow: call('follow'),
      likeLatestPost: call('likeLatestPost'),
      withdrawInvite: call('withdrawInvite'),
      searchPeople: call('searchPeople'),
    }
  }

  async withDriver<T>(userId: string, fn: (driver: LinkedInDriver) => Promise<T>): Promise<T> {
    this.sessions.push(userId)
    if (this.expired.has(userId)) throw new LinkedInError('session_expired', 'LinkedIn signed you out')
    return fn(this.driverFor(userId))
  }

  getAccount(): LinkedInAccount {
    throw new Error('not used by the engine')
  }
  loginWithPassword(): Promise<ConnectOutcome> {
    throw new Error('not used by the engine')
  }
  submitVerificationCode(): Promise<ConnectOutcome> {
    throw new Error('not used by the engine')
  }
  checkPendingLogin(): Promise<ConnectOutcome> {
    throw new Error('not used by the engine')
  }
  connectWithCookie(): Promise<ConnectOutcome> {
    throw new Error('not used by the engine')
  }
  test(): Promise<{ ok: boolean; message: string; account: LinkedInAccount }> {
    throw new Error('not used by the engine')
  }
  async disconnect() {}
  async shutdown() {}
}
