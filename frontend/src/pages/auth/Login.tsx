import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError, api, errorMessage, qk } from '../../api/client'
import { useAuth } from '../../auth/context'
import { FullScreenLoader } from '../../auth/FullScreen'
import { connectPath, safeNext } from '../../auth/links'
import { Alert, Button, Field, Input } from '../../components/ui'
import { AuthShell, EMAIL_RE, PasswordField } from './AuthShell'

export default function Login() {
  const { status, login } = useAuth()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const clearError = (k: string) =>
    setErrors((e) => {
      if (!e[k]) return e
      const next = { ...e }
      delete next[k]
      return next
    })

  // already signed in (e.g. opened /login in a new tab); the submit handler navigates itself
  if (!submitting && status === 'authenticated') return <Navigate to={next ?? '/'} replace />
  if (!submitting && status === 'loading') return <FullScreenLoader />

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const errs: Record<string, string> = {}
    if (!EMAIL_RE.test(email.trim())) errs.email = email.trim() ? 'Enter a valid email address' : 'Enter your email'
    if (!password) errs.password = 'Enter your password'
    setErrors(errs)
    setFormError(null)
    if (Object.keys(errs).length) return
    setSubmitting(true)
    try {
      await login(email.trim(), password)
    } catch (err) {
      setSubmitting(false)
      setErrors(err instanceof ApiError ? (err.details ?? {}) : {})
      setFormError(errorMessage(err))
      return
    }
    // users land on /connect until LinkedIn is connected; it continues to the page they asked for
    const account = await qc.fetchQuery({ queryKey: qk.linkedin, queryFn: api.getLinkedIn }).catch(() => null)
    navigate(account && account.status !== 'connected' ? connectPath(next) : (next ?? '/'), { replace: true })
  }

  return (
    <AuthShell
      title="Sign in"
      subtitle="Welcome back. Sign in to manage your LinkedIn campaigns."
      footer={
        <>
          New to LinkPilot?{' '}
          <Link to="/signup" className="font-semibold text-brand hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={submit} noValidate className="space-y-5">
        {formError && <Alert tone="bad">{formError}</Alert>}
        <Field label="Email" error={errors.email}>
          <Input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              clearError('email')
            }}
            aria-invalid={!!errors.email || undefined}
            disabled={submitting}
            autoFocus
            className="h-11"
          />
        </Field>
        <Field label="Password" error={errors.password}>
          {(a11y) => <PasswordField
              {...a11y}
              value={password}
              onChange={(v) => {
                setPassword(v)
                clearError('password')
              }}
              autoComplete="current-password"
              disabled={submitting}
            />}
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthShell>
  )
}
