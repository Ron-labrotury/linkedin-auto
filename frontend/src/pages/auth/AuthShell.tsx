import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Eye, EyeOff } from 'lucide-react'
import { api, ApiError } from '../../api/client'
import { Logo } from '../../components/layout/Logo'
import { Alert, Input } from '../../components/ui'

/** Explains a misconfigured deployment (no backend at VITE_API_URL) before anyone types a password. */
function ApiUnreachable() {
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, retry: 1, staleTime: 60_000 })
  if (!(health.error instanceof ApiError) || health.error.status !== 0) return null
  return (
    <Alert tone="bad" title="Can’t reach the LinkPilot server" className="mb-5">
      {health.error.message}
    </Alert>
  )
}

/** Centered card used by the sign-in and sign-up pages. */
export function AuthShell({ title, subtitle, children, footer }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="relative flex min-h-full flex-col items-center justify-center overflow-hidden px-4 py-10 sm:py-16">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] opacity-60"
        style={{ background: 'radial-gradient(60% 60% at 50% 0%, color-mix(in oklab, var(--color-brand) 22%, transparent), transparent)' }}
        aria-hidden
      />
      <div className="relative w-full max-w-md">
        <Logo to={null} className="mb-8 justify-center" />
        <main className="rounded-2xl border border-line/60 bg-panel p-6 shadow-2xl shadow-black/20 sm:p-8">
          <ApiUnreachable />
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <div className="mt-2 text-sm text-ink-2">{subtitle}</div>}
          <div className="mt-7">{children}</div>
        </main>
        {footer && <div className="mt-6 text-center text-sm text-ink-2">{footer}</div>}
      </div>
    </div>
  )
}

export function PasswordField({
  value,
  onChange,
  autoComplete,
  disabled,
  ...a11y
}: {
  value: string
  onChange: (v: string) => void
  autoComplete: 'current-password' | 'new-password'
  disabled?: boolean
  id: string
  'aria-describedby'?: string
  'aria-invalid'?: true
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <Input
        {...a11y}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        disabled={disabled}
        className="h-11 pr-11"
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        className="absolute inset-y-0 right-0 grid w-11 cursor-pointer place-items-center rounded-r-lg text-ink-3 hover:text-ink"
        aria-label={show ? 'Hide password' : 'Show password'}
        aria-pressed={show}
      >
        {show ? <EyeOff size={17} /> : <Eye size={17} />}
      </button>
    </div>
  )
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const MIN_PASSWORD = 8
