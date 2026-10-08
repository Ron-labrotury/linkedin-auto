/** Test doubles for the API tests: a scriptable LinkedInService and a fake engine. */
import type { LinkedInAccount } from '../../../shared/types.ts'
import type { ConnectOutcome, LinkedInDriver, LinkedInService } from '../../src/linkedin/types.ts'

export interface ServiceCall {
  method: string
  userId: string
  args: unknown[]
}

const disconnected = (): LinkedInAccount => ({
  status: 'disconnected',
  authMethod: null,
  email: null,
  profile: null,
  lastCheckedAt: null,
  lastError: null,
})

/**
 * Behaves like a tiny LinkedIn: password "needs-code" asks for code "123456", "needs-app" waits for
 * app approval (approved on the next check), anything else connects. Set `failWith` to make the
 * next call throw.
 */
export class FakeLinkedIn implements LinkedInService {
  readonly kind = 'simulated' as const
  readonly calls: ServiceCall[] = []
  readonly accounts = new Map<string, LinkedInAccount>()
  failWith: Error | null = null

  private record(method: string, userId: string, ...args: unknown[]) {
    this.calls.push({ method, userId, args })
    if (this.failWith) {
      const e = this.failWith
      this.failWith = null
      throw e
    }
  }

  private set(userId: string, patch: Partial<LinkedInAccount>, message: string): ConnectOutcome {
    const account = { ...this.getAccountRaw(userId), ...patch, lastCheckedAt: new Date().toISOString() }
    this.accounts.set(userId, account)
    return { account, message }
  }

  private getAccountRaw(userId: string) {
    return this.accounts.get(userId) ?? disconnected()
  }

  getAccount(userId: string): LinkedInAccount {
    return this.getAccountRaw(userId)
  }

  async loginWithPassword(userId: string, email: string, password: string): Promise<ConnectOutcome> {
    this.record('loginWithPassword', userId, email, password)
    if (password === 'needs-code')
      return this.set(userId, { status: 'needs_verification', authMethod: 'password', email }, 'Enter the code LinkedIn emailed you')
    if (password === 'needs-app')
      return this.set(userId, { status: 'needs_app_approval', authMethod: 'password', email }, 'Approve the sign-in in the LinkedIn app')
    return this.connect(userId, 'password', email)
  }

  async submitVerificationCode(userId: string, code: string): Promise<ConnectOutcome> {
    this.record('submitVerificationCode', userId, code)
    if (this.getAccountRaw(userId).status !== 'needs_verification') throw new Error('No sign-in is waiting for a code')
    if (code !== '123456') throw new Error('That code is not correct')
    return this.connect(userId, 'password', this.getAccountRaw(userId).email)
  }

  async checkPendingLogin(userId: string): Promise<ConnectOutcome> {
    this.record('checkPendingLogin', userId)
    if (this.getAccountRaw(userId).status !== 'needs_app_approval') throw new Error('No sign-in is waiting for approval')
    return this.connect(userId, 'password', this.getAccountRaw(userId).email)
  }

  async connectWithCookie(userId: string, liAt: string): Promise<ConnectOutcome> {
    this.record('connectWithCookie', userId, liAt)
    return this.connect(userId, 'cookie', null)
  }

  async test(userId: string) {
    this.record('test', userId)
    const account = this.getAccountRaw(userId)
    const ok = account.status === 'connected'
    return { ok, message: ok ? 'Connected as Test User' : 'Connect your LinkedIn account first', account }
  }

  async disconnect(userId: string): Promise<void> {
    this.record('disconnect', userId)
    this.accounts.set(userId, disconnected())
  }

  async withDriver<T>(_userId: string, _fn: (driver: LinkedInDriver) => Promise<T>): Promise<T> {
    throw new Error('withDriver is not used by the API')
  }

  async shutdown() {}

  private connect(userId: string, authMethod: 'password' | 'cookie', email: string | null) {
    return this.set(
      userId,
      {
        status: 'connected',
        authMethod,
        email,
        lastError: null,
        profile: { name: 'Test User', headline: 'Tester', profileUrl: 'https://www.linkedin.com/in/test-user/', imageUrl: null },
      },
      'LinkedIn account connected',
    )
  }
}

export class FakeEngine {
  readonly next = new Map<string, number | null>()
  nextActionAt(userId: string): number | null {
    return this.next.get(userId) ?? null
  }
}
