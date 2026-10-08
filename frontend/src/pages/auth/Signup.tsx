import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Check, Lock, Users } from 'lucide-react'
import { ApiError, api, errorMessage } from '../../api/client'
import { useAuth } from '../../auth/context'
import { FullScreenLoader } from '../../auth/FullScreen'
import { Alert, Button, Field, Input, Skeleton } from '../../components/ui'
import { cn } from '../../lib/utils'
import { AuthShell, EMAIL_RE, MIN_PASSWORD, PasswordField } from './AuthShell'

const ROLE_LABEL = { owner: 'an owner', admin: 'an admin', member: 'a member' } as const

export default function Signup() {
  const { status, user, signup, logout } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const inviteToken = params.get('invite')?.trim() || null
  const invite = useQuery({
    queryKey: ['invite', inviteToken],
    queryFn: () => api.getInvite(inviteToken!),
    enabled: !!inviteToken,
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 1,
    staleTime: Infinity,
  })
  const [name, setName] = useState('')
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

  if (!submitting && status === 'loading') return <FullScreenLoader />
  if (!submitting && status === 'authenticated') {
    if (!inviteToken) return <Navigate to="/" replace />
    // opened an invite link while signed in as someone else
    return (
      <AuthShell title="You’re already signed in" subtitle={<>You’re signed in as <span className="font-medium text-ink">{user?.email}</span>.</>}>
        <div className="space-y-4">
          <p className="text-sm text-ink-2">To accept this invite with a new account, sign out first.</p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => void logout(`/signup?invite=${encodeURIComponent(inviteToken)}`)}>Sign out and continue</Button>
            <Button variant="outline" onClick={() => navigate('/')}>Go to dashboard</Button>
          </div>
        </div>
      </AuthShell>
    )
  }

  const invited = invite.data ?? null
  const inviteFailed = !!inviteToken && invite.isError
  const effectiveEmail = invited ? invited.email : email
  const passwordOk = password.length >= MIN_PASSWORD

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const errs: Record<string, string> = {}
    if (!name.trim()) errs.name = 'Enter your name'
    else if (name.trim().length > 80) errs.name = 'Name must be at most 80 characters'
    if (!EMAIL_RE.test(effectiveEmail.trim())) errs.email = effectiveEmail.trim() ? 'Enter a valid email address' : 'Enter your email'
    if (!passwordOk) errs.password = `Password must be at least ${MIN_PASSWORD} characters`
    setErrors(errs)
    setFormError(null)
    if (Object.keys(errs).length) return
    setSubmitting(true)
    try {
      await signup({ name: name.trim(), email: effectiveEmail.trim(), password, inviteToken: invited ? inviteToken! : undefined })
    } catch (err) {
      setSubmitting(false)
      setErrors(err instanceof ApiError ? (err.details ?? {}) : {})
      setFormError(errorMessage(err))
      return
    }
    navigate('/connect', { replace: true })
  }

  const footer = (
    <>
      Already have an account?{' '}
      <Link to="/login" className="font-semibold text-brand hover:underline">
        Sign in
      </Link>
    </>
  )

  if (inviteToken && invite.isPending) {
    return (
      <AuthShell title="Checking your invite…" footer={footer}>
        <div className="space-y-4" role="status" aria-label="Loading invite">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title={invited ? `Join ${invited.workspaceName}` : 'Create your account'}
      subtitle={
        invited ? (
          <span className="inline-flex items-center gap-2">
            <Users size={16} className="text-brand" aria-hidden />
            You’ve been invited to join as {ROLE_LABEL[invited.role]}.
          </span>
        ) : (
          'Automate LinkedIn outreach with your own sequences. Start by creating an account.'
        )
      }
      footer={footer}
    >
      {inviteFailed && (
        <Alert tone="warn" className="mb-5" title="This invite link can’t be used">
          {errorMessage(invite.error)}{' '}
          <Link to="/signup" replace className="font-medium text-brand hover:underline">
            Sign up without an invite
          </Link>{' '}
          or ask for a new link.
        </Alert>
      )}
      <form onSubmit={submit} noValidate className="space-y-5">
        {formError && <Alert tone="bad">{formError}</Alert>}
        <Field label="Your name" error={errors.name}>
          <Input
            autoComplete="name"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              clearError('name')
            }}
            aria-invalid={!!errors.name || undefined}
            disabled={submitting}
            maxLength={80}
            autoFocus
            className="h-11"
          />
        </Field>
        <Field label="Work email" error={errors.email} hint={invited ? 'The invite was sent to this address.' : undefined}>
          <div className="relative">
            <Input
              type="email"
              autoComplete="email"
              value={effectiveEmail}
              onChange={(e) => {
                setEmail(e.target.value)
                clearError('email')
              }}
              readOnly={!!invited}
              aria-readonly={!!invited || undefined}
              aria-invalid={!!errors.email || undefined}
              disabled={submitting}
              className={cn('h-11', invited && 'cursor-not-allowed pr-10 text-ink-2 focus:border-line focus:ring-0')}
            />
            {invited && <Lock size={16} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />}
          </div>
        </Field>
        <Field
          label="Password"
          error={errors.password}
          hint={
            <span className={cn('inline-flex items-center gap-1.5', passwordOk && 'text-ok')}>
              {passwordOk && <Check size={13} aria-hidden />}
              At least {MIN_PASSWORD} characters{password && !passwordOk ? ` (${MIN_PASSWORD - password.length} more)` : ''}
            </span>
          }
        >
          {(a11y) => <PasswordField
              {...a11y}
              value={password}
              onChange={(v) => {
                setPassword(v)
                clearError('password')
              }}
              autoComplete="new-password"
              disabled={submitting}
            />}
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={submitting}>
          {submitting ? 'Creating your account…' : invited ? `Join ${invited.workspaceName}` : 'Create account'}
        </Button>
      </form>
    </AuthShell>
  )
}
