import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import type { AuthResponse, User } from '@shared/types.ts'
import { ApiError, UNAUTHORIZED_EVENT, api, qk, tokenStore } from '../api/client'
import { useMe } from '../api/hooks-account'
import { AuthContext, type AuthStatus, type AuthValue, type SignupInput } from './context'
import { isPublicPath, loginPath } from './links'

/**
 * Owns the session token. The user comes from GET /auth/me whenever a token exists; a 401 anywhere
 * (UNAUTHORIZED_EVENT from the API client) ends the session, clears all cached data and goes to /login.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [token, setTokenState] = useState(() => tokenStore.get())
  const tokenRef = useRef(token)
  const me = useMe(!!token)

  const setToken = useCallback((t: string | null) => {
    tokenRef.current = t
    setTokenState(t)
  }, [])

  const begin = useCallback(
    (res: AuthResponse): User => {
      // never show a previous user's data (signing out already clears the cache)
      if (tokenRef.current) qc.clear()
      tokenStore.set(res.token)
      qc.setQueryData(qk.me, res.user)
      setToken(res.token)
      return res.user
    },
    [qc, setToken],
  )

  const end = useCallback(() => {
    tokenStore.set(null)
    setToken(null)
    qc.clear()
  }, [qc, setToken])

  useEffect(() => {
    const onUnauthorized = () => {
      if (!tokenRef.current) return
      const { pathname, search } = window.location
      end()
      if (!isPublicPath(pathname)) navigate(loginPath(pathname + search), { replace: true })
    }
    // keep tabs in sync: signing in or out in another tab changes the stored token
    const onStorage = () => {
      const stored = tokenStore.get()
      if (stored === tokenRef.current) return
      qc.clear()
      setToken(stored)
    }
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
      window.removeEventListener('storage', onStorage)
    }
  }, [end, navigate, qc, setToken])

  const login = useCallback(async (email: string, password: string) => begin(await api.login({ email, password })), [begin])
  const signup = useCallback(async (input: SignupInput) => begin(await api.signup(input)), [begin])

  const logout = useCallback(
    async (to = '/login') => {
      if (tokenRef.current) await api.logout().catch(() => {}) // the session ends locally either way
      end()
      navigate(to, { replace: true })
    },
    [end, navigate],
  )

  const user = token ? (me.data ?? null) : null
  // a 401 clears the token via UNAUTHORIZED_EVENT; any other failure (offline, 500) is shown with a retry
  const unauthorized = me.error instanceof ApiError && me.error.status === 401
  const status: AuthStatus = !token || unauthorized ? 'anonymous' : user ? 'authenticated' : me.isError && !me.isFetching ? 'error' : 'loading'
  const { refetch } = me

  const value = useMemo<AuthValue>(
    () => ({ status, user, error: status === 'error' ? me.error : null, retry: () => void refetch(), login, signup, logout }),
    [status, user, me.error, refetch, login, signup, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
