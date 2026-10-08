import type { ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { ApiError } from '../api/client'
import { useAuth } from './context'
import { FullScreenError, FullScreenLoader } from './FullScreen'
import { loginPath } from './links'

/** Renders its children (or the nested routes) only for a signed-in user; otherwise sends them to /login?next=… */
export function RequireAuth({ children }: { children?: ReactNode }) {
  const { status, error, retry, logout } = useAuth()
  const location = useLocation()
  if (status === 'loading') return <FullScreenLoader />
  if (status === 'error') return <FullScreenError message={describe(error)} onRetry={retry} onSignOut={() => void logout()} />
  if (status === 'anonymous') return <Navigate to={loginPath(location.pathname + location.search)} replace />
  return children ?? <Outlet />
}

function describe(error: Error | null) {
  if (error instanceof ApiError && error.status >= 500) return `The server isn’t responding right now (error ${error.status}). Try again in a moment.`
  return error?.message
}
