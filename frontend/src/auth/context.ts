import { createContext, useContext } from 'react'
import type { User } from '@shared/types.ts'

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'error'

export interface SignupInput {
  name: string
  email: string
  password: string
  inviteToken?: string
}

export interface AuthValue {
  status: AuthStatus
  user: User | null
  /** why the session could not be resolved (status "error", e.g. server unreachable) */
  error: Error | null
  retry: () => void
  login: (email: string, password: string) => Promise<User>
  signup: (input: SignupInput) => Promise<User>
  /** Ends the session and goes to `to` (default /login). */
  logout: (to?: string) => Promise<void>
}

export const AuthContext = createContext<AuthValue | null>(null)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

