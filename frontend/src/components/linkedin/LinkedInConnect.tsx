import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Cookie, ExternalLink, Eye, EyeOff, KeyRound, Lock, MailCheck, RefreshCw, ShieldCheck, Smartphone, Unplug } from 'lucide-react'
import type { LinkedInAccount, LinkedInConnectResponse, LinkedInStatus } from '@shared/types.ts'
import { ApiError, errorMessage } from '../../api/client'
import {
  useLinkedIn,
  useLinkedInCheck,
  useLinkedInCookie,
  useLinkedInDisconnect,
  useLinkedInLogin,
  useLinkedInTest,
  useLinkedInVerify,
} from '../../api/hooks-account'
import { toast } from '../../lib/toast'
import { cn, timeAgo } from '../../lib/utils'
import { Alert, Button, ConfirmModal, ErrorState, Field, Input, SegmentedControl, Skeleton, Spinner } from '../ui'
import { LinkedInStatusBadge } from './status'
import { ProfilePhoto } from './ProfilePhoto'

const POLL_EVERY_MS = 3000
const POLL_FOR_MS = 2 * 60_000

type OnResult = (res: LinkedInConnectResponse) => void

/**
 * Connect / test / disconnect the user's LinkedIn account. Used by the onboarding page and Settings.
 * Everything is driven by the account status from the API, so a reload resumes the right step.
 */
export function LinkedInConnect({ onConnected }: { onConnected?: () => void }) {
  const query = useLinkedIn()
  const [notice, setNotice] = useState<{ status: LinkedInStatus; message: string } | null>(null)

  const handleResult = useCallback<OnResult>(
    (res) => {
      setNotice({ status: res.account.status, message: res.message })
      if (res.account.status === 'connected') {
        toast(res.message || 'LinkedIn account connected', 'success')
        onConnected?.()
      } else if (res.account.status === 'error') toast(res.message || 'Couldn’t connect your LinkedIn account', 'error')
    },
    [onConnected],
  )

  // keep showing the last known account when a background refetch fails
  if (!query.data)
    return query.isError ? (
      <ErrorState title="Couldn’t load your LinkedIn account" message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
    ) : (
      <ConnectSkeleton />
    )

  const account = query.data
  const message = notice?.status === account.status ? notice.message : null

  switch (account.status) {
    case 'connected':
      return <ConnectedAccount account={account} />
    case 'needs_verification':
      return <VerifyCode account={account} message={message} onResult={handleResult} />
    case 'needs_app_approval':
      return <AppApproval onResult={handleResult} />
    default:
      return (
        <div className="space-y-5">
          {(account.status === 'expired' || account.status === 'error') && <ReconnectNotice account={account} />}
          <ConnectForms account={account} onResult={handleResult} />
        </div>
      )
  }
}

function ConnectSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading LinkedIn account">
      <div className="flex items-center gap-4">
        <Skeleton className="size-14 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-64 max-w-full" />
        </div>
      </div>
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  )
}

/* ------------------------------ connected ------------------------------ */

function ConnectedAccount({ account }: { account: LinkedInAccount }) {
  const test = useLinkedInTest()
  const disconnect = useLinkedInDisconnect()
  const [confirm, setConfirm] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const profile = account.profile
  const name = profile?.name || account.email || 'LinkedIn account'

  const runTest = () => {
    setResult(null)
    test.mutate(undefined, {
      onSuccess: (res) => {
        setResult({ ok: res.ok, message: res.message })
        toast(res.message, res.ok ? 'success' : 'error')
      },
      onError: (e) => {
        setResult({ ok: false, message: errorMessage(e) })
        toast(errorMessage(e), 'error')
      },
    })
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line bg-bg/40 p-4 sm:p-5">
        <div className="flex items-start gap-4">
          <ProfilePhoto name={name} src={profile?.imageUrl} size={56} />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <p className="truncate text-base font-semibold">{name}</p>
              <LinkedInStatusBadge status={account.status} />
            </div>
            {profile?.headline && <p className="line-clamp-2 text-sm text-ink-2">{profile.headline}</p>}
            <p className="text-xs text-ink-3">
              {account.authMethod === 'cookie' ? 'Connected with a session cookie' : account.email ? `Signed in as ${account.email}` : 'Signed in with email & password'}
              {' · '}
              {account.lastCheckedAt ? <>Last checked {timeAgo(account.lastCheckedAt)}</> : 'Not checked yet'}
            </p>
            {account.lastError && !result && <p className="text-xs text-warn">Last check: {account.lastError}</p>}
            {profile?.profileUrl && (
              <a
                href={profile.profileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline"
              >
                View LinkedIn profile <ExternalLink size={14} aria-hidden />
              </a>
            )}
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button onClick={runTest} loading={test.isPending}>
            {!test.isPending && <RefreshCw size={16} aria-hidden />}
            {test.isPending ? 'Testing…' : 'Test connection'}
          </Button>
          <Button variant="outline" onClick={() => setConfirm(true)} loading={disconnect.isPending} disabled={test.isPending}>
            {!disconnect.isPending && <Unplug size={16} aria-hidden />}
            Disconnect
          </Button>
          {test.isPending && <span className="text-xs text-ink-3">Opening LinkedIn with your saved session – this can take up to a minute.</span>}
        </div>
      </div>
      {result && (
        <Alert tone={result.ok ? 'ok' : 'bad'} title={result.ok ? 'Connection works' : 'Test failed'}>
          {result.message}
        </Alert>
      )}
      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Disconnect LinkedIn?"
        body="Campaigns stop sending until you connect an account again. Your campaigns, leads and settings are kept."
        confirmLabel="Disconnect"
        onConfirm={() =>
          disconnect.mutate(undefined, {
            onSuccess: () => toast('LinkedIn account disconnected', 'success'),
            onError: (e) => toast(errorMessage(e), 'error'),
          })
        }
      />
    </div>
  )
}

/* ------------------------------ reconnect ------------------------------ */

function ReconnectNotice({ account }: { account: LinkedInAccount }) {
  const test = useLinkedInTest()
  const expired = account.status === 'expired'
  // a stored session may still work (e.g. LinkedIn was briefly unreachable) – let the user re-test it
  const canTest = account.authMethod !== null && (expired || account.profile !== null)
  // 'error' on an account that was connected: LinkedIn reported a problem the user must fix (lastError says what)
  const problem = !expired && account.profile !== null
  return (
    <Alert
      tone="bad"
      title={expired ? 'Your LinkedIn session expired' : problem ? 'Your LinkedIn account needs attention' : 'Couldn’t connect your LinkedIn account'}
      action={
        canTest ? (
          <Button
            size="sm"
            variant="outline"
            loading={test.isPending}
            onClick={() =>
              test.mutate(undefined, {
                onSuccess: (res) => toast(res.message, res.ok ? 'success' : 'error'),
                onError: (e) => toast(errorMessage(e), 'error'),
              })
            }
          >
            Test again
          </Button>
        ) : undefined
      }
    >
      <p>{account.lastError || (expired ? 'LinkedIn signed this account out.' : 'The last sign-in attempt failed.')}</p>
      <p className="mt-1">
        {problem && canTest
          ? 'Fix this, then click “Test again” (or reconnect below) – campaigns are on hold until then.'
          : `${account.profile ? `Reconnect ${account.profile.name}'s account below` : 'Try again below'} – campaigns wait until LinkedIn is connected.`}
      </p>
    </Alert>
  )
}

/* ------------------------------ connect forms ------------------------------ */

type Method = 'password' | 'cookie'

function ConnectForms({ account, onResult }: { account: LinkedInAccount; onResult: OnResult }) {
  const [method, setMethod] = useState<Method>(account.authMethod === 'cookie' ? 'cookie' : 'password')
  return (
    <div className="space-y-5">
      <SegmentedControl
        label="How to connect"
        value={method}
        onChange={setMethod}
        options={[
          { id: 'password', label: 'Email & password', icon: <KeyRound size={16} className="hidden sm:block" aria-hidden /> },
          { id: 'cookie', label: 'Session cookie', icon: <Cookie size={16} className="hidden sm:block" aria-hidden /> },
        ]}
      />
      <div role="tabpanel">
        {method === 'password' ? <PasswordForm defaultEmail={account.email} onResult={onResult} /> : <CookieForm onResult={onResult} />}
      </div>
    </div>
  )
}

const fieldErrors = (e: unknown) => (e instanceof ApiError ? (e.details ?? {}) : {})

function PasswordInput({
  value,
  onChange,
  autoComplete,
  placeholder,
  disabled,
  ...a11y
}: {
  value: string
  onChange: (v: string) => void
  autoComplete: string
  placeholder?: string
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
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        className="pr-11"
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        className="absolute inset-y-0 right-0 grid w-10 cursor-pointer place-items-center rounded-r-lg text-ink-3 hover:text-ink"
        aria-label={show ? 'Hide' : 'Show'}
        aria-pressed={show}
      >
        {show ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  )
}

function PasswordForm({ defaultEmail, onResult }: { defaultEmail: string | null; onResult: OnResult }) {
  const login = useLinkedInLogin()
  const [email, setEmail] = useState(defaultEmail ?? '')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const clearError = (k: string) =>
    setErrors((e) => {
      if (!e[k]) return e
      const next = { ...e }
      delete next[k]
      return next
    })

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const errs: Record<string, string> = {}
    if (!email.trim()) errs.email = 'Enter the email or phone number you use for LinkedIn'
    if (!password) errs.password = 'Enter your LinkedIn password'
    setErrors(errs)
    setFormError(null)
    if (Object.keys(errs).length) return
    try {
      const res = await login.mutateAsync({ email: email.trim(), password })
      setPassword('')
      onResult(res)
    } catch (err) {
      setErrors(fieldErrors(err))
      setFormError(errorMessage(err))
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field label="LinkedIn email or phone" error={errors.email}>
        <Input
          type="text"
          inputMode="email"
          autoComplete="username"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            clearError('email')
          }}
          placeholder="you@company.com"
          aria-invalid={!!errors.email || undefined}
          disabled={login.isPending}
        />
      </Field>
      <Field label="LinkedIn password" error={errors.password}>
        {(a11y) => (
          <PasswordInput
            {...a11y}
            value={password}
            onChange={(v) => {
              setPassword(v)
              clearError('password')
            }}
            autoComplete="current-password"
            disabled={login.isPending}
          />
        )}
      </Field>
      {formError && <Alert tone="bad">{formError}</Alert>}
      <p className="flex items-start gap-2 text-xs text-ink-3">
        <Lock size={14} className="mt-px shrink-0" aria-hidden />
        Your password is only used to sign in once and is never stored. We keep the encrypted LinkedIn session so campaigns can run while you’re offline.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={login.isPending}>
          {login.isPending ? 'Signing in to LinkedIn…' : 'Connect LinkedIn'}
        </Button>
        {login.isPending && <span className="text-xs text-ink-3">This can take up to a minute. Keep this page open.</span>}
      </div>
    </form>
  )
}

/** Strips what people commonly paste along with the value ("li_at=", quotes, trailing ";"). */
function cleanLiAt(raw: string) {
  return raw
    .trim()
    .replace(/^li_at\s*=\s*/i, '')
    .replace(/;$/, '')
    .replace(/^"(.*)"$/, '$1')
    .trim()
}

function CookieForm({ onResult }: { onResult: OnResult }) {
  const connect = useLinkedInCookie()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const liAt = cleanLiAt(value)
    if (liAt.length < 10) {
      setError(liAt ? 'That doesn’t look like a complete li_at value – copy the whole Value cell' : 'Paste the value of your li_at cookie')
      return
    }
    setError(null)
    try {
      const res = await connect.mutateAsync(liAt)
      if (res.account.status === 'connected') setValue('')
      onResult(res)
    } catch (err) {
      setError(fieldErrors(err).liAt ?? errorMessage(err))
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div className="rounded-xl border border-line bg-bg/40 p-4 text-sm">
        <p className="font-medium text-ink">How to copy your li_at cookie</p>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-ink-2 marker:text-ink-3">
          <li>
            Open{' '}
            <a href="https://www.linkedin.com" target="_blank" rel="noopener noreferrer" className="font-medium text-brand hover:underline">
              linkedin.com
            </a>{' '}
            on a computer and make sure you’re signed in.
          </li>
          <li>
            Open DevTools: <kbd className="rounded bg-panel-2 px-1.5 py-0.5 text-xs">F12</kbd> on Windows/Linux, <kbd className="rounded bg-panel-2 px-1.5 py-0.5 text-xs">⌥ ⌘ I</kbd> on Mac.
          </li>
          <li>
            Go to <span className="font-medium text-ink">Application</span> → <span className="font-medium text-ink">Cookies</span> → <span className="font-medium text-ink">https://www.linkedin.com</span>{' '}
            (Firefox: Storage → Cookies).
          </li>
          <li>
            Find the row named <code className="rounded bg-panel-2 px-1.5 py-0.5 text-xs text-ink">li_at</code> and copy its <span className="font-medium text-ink">Value</span>.
          </li>
        </ol>
        <p className="mt-3 text-xs text-ink-3">Don’t sign out of LinkedIn in that browser afterwards – signing out ends this session too. Just close the tab.</p>
      </div>
      <Field label="li_at cookie value" error={error}>
        {(a11y) => (
          <PasswordInput
            {...a11y}
            value={value}
            onChange={(v) => {
              setValue(v)
              setError(null)
            }}
            autoComplete="off"
            placeholder="AQEDAR…"
            disabled={connect.isPending}
          />
        )}
      </Field>
      <p className="flex items-start gap-2 text-xs text-ink-3">
        <Lock size={14} className="mt-px shrink-0" aria-hidden />
        The session is stored encrypted on the server and is only used to run your campaigns.
      </p>
      <Button type="submit" loading={connect.isPending}>
        {connect.isPending ? 'Checking the cookie…' : 'Connect with cookie'}
      </Button>
    </form>
  )
}

/* ------------------------------ verification ------------------------------ */

function StartOver({ disabled }: { disabled?: boolean }) {
  const cancel = useLinkedInDisconnect()
  return (
    <Button
      variant="ghost"
      type="button"
      disabled={disabled}
      loading={cancel.isPending}
      onClick={() => cancel.mutate(undefined, { onError: (e) => toast(errorMessage(e), 'error') })}
    >
      Start over
    </Button>
  )
}

function VerifyCode({ account, message, onResult }: { account: LinkedInAccount; message: string | null; onResult: OnResult }) {
  const verify = useLinkedInVerify()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const shownError = error ?? account.lastError

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const clean = code.replace(/\s+/g, '')
    if (!/^\d{4,10}$/.test(clean)) {
      setError('Enter the 4–10 digit code LinkedIn sent you')
      return
    }
    setError(null)
    try {
      const res = await verify.mutateAsync(clean)
      if (res.account.status === 'needs_verification') {
        // still waiting: wrong / expired code
        setError(res.account.lastError ?? res.message)
        setCode('')
      } else onResult(res)
    } catch (err) {
      setError(fieldErrors(err).code ?? errorMessage(err))
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      <div className="flex items-start gap-4">
        <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-warn/15 text-warn">
          <MailCheck size={24} aria-hidden />
        </span>
        <div>
          <p className="font-semibold">Enter the verification code</p>
          <p className="mt-1 text-sm text-ink-2">
            {message ?? 'LinkedIn sent a verification code to your email or phone (or use your authenticator app). Enter it to finish connecting.'}
          </p>
          {account.email && <p className="mt-1 text-xs text-ink-3">Signing in as {account.email}</p>}
        </div>
      </div>
      <Field label="Verification code" error={shownError}>
        <Input
          value={code}
          onChange={(e) => {
            setCode(e.target.value.replace(/[^\d\s]/g, ''))
            setError(null)
          }}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={12}
          placeholder="123456"
          autoFocus
          aria-invalid={!!shownError || undefined}
          className="h-12 max-w-56 text-center font-mono text-lg tracking-[0.3em]"
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={verify.isPending}>
          {verify.isPending ? 'Verifying…' : 'Verify and connect'}
        </Button>
        <StartOver disabled={verify.isPending} />
      </div>
    </form>
  )
}

function AppApproval({ onResult }: { onResult: OnResult }) {
  const check = useLinkedInCheck()
  const [polling, setPolling] = useState(true)
  const [manual, setManual] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const busy = useRef(false)
  const failures = useRef(0)
  const startedAt = useRef(Date.now())
  const refs = useRef({ check: check.mutateAsync, onResult })
  useEffect(() => {
    refs.current = { check: check.mutateAsync, onResult }
  })

  const runCheck = useCallback(async (byUser: boolean) => {
    if (busy.current) return
    busy.current = true
    if (byUser) setManual(true)
    try {
      const res = await refs.current.check(undefined)
      failures.current = 0
      setError(null)
      if (byUser && res.account.status === 'needs_app_approval') setHint('LinkedIn hasn’t seen the approval yet. Tap “Yes” in the app, then try again.')
      refs.current.onResult(res)
    } catch (e) {
      setError(errorMessage(e))
      if (++failures.current >= 3) setPolling(false)
    } finally {
      busy.current = false
      if (byUser) setManual(false)
    }
  }, [])

  useEffect(() => {
    if (!polling) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      if (cancelled) return
      if (Date.now() - startedAt.current >= POLL_FOR_MS) {
        setPolling(false)
        return
      }
      await runCheck(false)
      if (!cancelled) timer = setTimeout(tick, POLL_EVERY_MS)
    }
    timer = setTimeout(tick, POLL_EVERY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [polling, runCheck])

  const resume = () => {
    startedAt.current = Date.now()
    failures.current = 0
    setError(null)
    setPolling(true)
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-4">
        <span className="relative grid size-12 shrink-0 place-items-center rounded-2xl bg-warn/15 text-warn">
          <Smartphone size={24} aria-hidden />
          {polling && (
            <span className="absolute -right-1 -top-1 flex size-3.5" aria-hidden>
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-warn/70" />
              <span className="relative inline-flex size-3.5 rounded-full border-2 border-panel bg-warn" />
            </span>
          )}
        </span>
        <div>
          <p className="font-semibold">Approve the sign-in on your phone</p>
          <p className="mt-1 text-sm text-ink-2">Open the LinkedIn app on your phone and approve the sign-in. We’ll notice automatically.</p>
        </div>
      </div>
      <div className={cn('flex items-center gap-2 text-sm', polling ? 'text-ink-2' : 'text-ink-3')} role="status" aria-live="polite">
        {polling ? (
          <>
            <Spinner size={16} className="text-warn" /> Waiting for your approval…
          </>
        ) : (
          <>We stopped checking automatically. After approving in the app, click “I’ve approved it”.</>
        )}
      </div>
      {error && <Alert tone="bad">{error}</Alert>}
      {hint && !error && <Alert tone="warn">{hint}</Alert>}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void runCheck(true)} loading={manual}>
          {!manual && <ShieldCheck size={16} aria-hidden />} I’ve approved it
        </Button>
        {!polling && (
          <Button variant="outline" onClick={resume}>
            Keep waiting
          </Button>
        )}
        <StartOver disabled={manual} />
      </div>
    </div>
  )
}
