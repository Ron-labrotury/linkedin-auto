import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { Clock, Globe, LogOut, MoonStar, Shuffle, Sun } from 'lucide-react'
import type { UserSettings } from '@shared/types.ts'
import { MAX_GAP_MINUTES, validateUserSettings } from '@shared/time.ts'
import { ApiError, errorMessage } from '../api/client'
import { useChangePassword, useLinkedIn, useSettings, useUpdateMe, useUpdateSettings } from '../api/hooks-account'
import { useAuth } from '../auth/context'
import { LinkedInConnect } from '../components/linkedin/LinkedInConnect'
import { WEEKDAYS, browserTimeZone, sameSettings, scheduleStatus, timeZoneOptions, windowLength } from '../components/linkedin/schedule'
import { Alert, Badge, Button, Card, ErrorState, Field, Input, PageHeader, Select, Skeleton } from '../components/ui'
import { toast } from '../lib/toast'
import { cn } from '../lib/utils'

function Section({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-24">
      <Card className="grid gap-6 p-5 sm:p-8 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div>
          <h2 id={`${id}-title`} className="font-semibold">
            {title}
          </h2>
          {description && <div className="mt-1 text-sm text-ink-3">{description}</div>}
        </div>
        <div className="min-w-0 space-y-5">{children}</div>
      </Card>
    </section>
  )
}

function useNow(everyMs: number) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}

const detailsOf = (e: unknown) => (e instanceof ApiError ? (e.details ?? {}) : {})

/* ------------------------------ active hours ------------------------------ */

function ScheduleLine({ settings, unsaved }: { settings: UserSettings; unsaved: boolean }) {
  const now = useNow(30_000)
  const status = scheduleStatus(now, settings)
  const zone = settings.timezone.replace(/_/g, ' ')
  if (status.state === 'invalid') return <p className="text-sm text-ink-3">Fix the highlighted fields to see when actions run.</p>
  const localNow = new Intl.DateTimeFormat('en-US', { timeZone: settings.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now)
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn('flex items-start gap-3 rounded-xl border p-4 text-sm', status.state === 'active' ? 'border-ok/30 bg-ok/10' : 'border-warn/30 bg-warn/10')}
    >
      {status.state === 'active' ? <Sun size={18} className="mt-px shrink-0 text-ok" aria-hidden /> : <MoonStar size={18} className="mt-px shrink-0 text-warn" aria-hidden />}
      <div className="min-w-0">
        <p className="font-semibold text-ink">
          {status.state === 'active'
            ? `Active now – actions run until ${status.until}`
            : status.state === 'waiting'
              ? `Outside active hours – next window starts ${status.label}`
              : 'No upcoming active window'}
          {status.state === 'waiting' && <span className="font-normal text-ink-2"> ({status.relative})</span>}
        </p>
        <p className="mt-0.5 text-ink-2">
          It’s {localNow} in {zone}.{unsaved && ' Preview of your unsaved changes.'}
        </p>
      </div>
    </div>
  )
}

function ActiveHours() {
  const query = useSettings()
  const save = useUpdateSettings()
  const [draft, setDraft] = useState<UserSettings | null>(null)
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const saved = query.data
  const browserTz = useMemo(browserTimeZone, [])
  const zones = useMemo(() => timeZoneOptions(new Date(), [saved?.timezone, browserTz]), [saved?.timezone, browserTz])

  if (!query.data)
    return query.isError ? (
      <ErrorState title="Couldn’t load your active hours" message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
    ) : (
      <div className="space-y-4" role="status" aria-label="Loading active hours">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-3/4" />
        <Skeleton className="h-10 w-1/2" />
      </div>
    )

  const value = draft ?? query.data
  const dirty = draft !== null && !sameSettings(draft, query.data)
  const clientErrors = draft ? validateUserSettings(value) : {}
  const errors: Record<string, string> = { ...clientErrors, ...serverErrors }

  const change = (patch: Partial<UserSettings>) => {
    setDraft({ ...value, ...patch })
    setServerErrors({})
    setFormError(null)
  }
  const toggleDay = (day: number) =>
    change({ activeDays: value.activeDays.includes(day) ? value.activeDays.filter((d) => d !== day) : [...value.activeDays, day].sort((a, b) => a - b) })
  const numberOrNaN = (s: string) => (s.trim() === '' ? Number.NaN : Number(s))

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!dirty || Object.keys(validateUserSettings(value)).length) return
    save.mutate(value, {
      onSuccess: () => {
        setDraft(null)
        toast('Active hours saved', 'success')
      },
      onError: (err) => {
        setServerErrors(detailsOf(err))
        setFormError(errorMessage(err))
      },
    })
  }

  const length = windowLength(value.activeStart, value.activeEnd)

  return (
    <form onSubmit={submit} noValidate className="space-y-6">
      <div className="space-y-2">
        <Field label="Time zone" error={errors.timezone}>
          <Select value={value.timezone} onChange={(e) => change({ timezone: e.target.value })} aria-invalid={!!errors.timezone || undefined}>
            {zones.map((z) => (
              <option key={z.value} value={z.value}>
                {z.label}
              </option>
            ))}
          </Select>
        </Field>
        {browserTz && browserTz !== value.timezone && (
          <button type="button" onClick={() => change({ timezone: browserTz })} className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-brand hover:underline">
            <Globe size={14} aria-hidden /> Use my time zone ({browserTz.replace(/_/g, ' ')})
          </button>
        )}
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-sm font-medium text-ink-2">Working days</legend>
        <div className="flex flex-wrap gap-2">
          {WEEKDAYS.map((d) => {
            const on = value.activeDays.includes(d.day)
            return (
              <button
                key={d.day}
                type="button"
                aria-pressed={on}
                aria-label={d.long}
                onClick={() => toggleDay(d.day)}
                className={cn(
                  'h-10 min-w-12 cursor-pointer rounded-lg border px-3 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
                  on ? 'border-brand bg-brand-soft text-brand' : 'border-line bg-bg/60 text-ink-3 hover:border-line-strong hover:text-ink',
                )}
              >
                {d.short}
              </button>
            )
          })}
        </div>
        {errors.activeDays && (
          <p role="alert" className="text-xs font-medium text-bad">
            {errors.activeDays}
          </p>
        )}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Start time" error={errors.activeStart}>
          <Input type="time" step={60} value={value.activeStart} onChange={(e) => change({ activeStart: e.target.value })} aria-invalid={!!errors.activeStart || undefined} required />
        </Field>
        <Field label="End time" error={errors.activeEnd} hint={length ? `${length} of activity per working day` : undefined}>
          <Input type="time" step={60} value={value.activeEnd} onChange={(e) => change({ activeEnd: e.target.value })} aria-invalid={!!errors.activeEnd || undefined} required />
        </Field>
      </div>

      <fieldset className="space-y-3">
        <legend className="flex items-center gap-2 text-sm font-medium text-ink-2">
          <Shuffle size={15} aria-hidden /> Random pause between LinkedIn actions
        </legend>
        <div className="grid grid-cols-2 gap-4 sm:max-w-md">
          <Field label="Minimum (minutes)" error={errors.gapMinMinutes}>
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              max={MAX_GAP_MINUTES}
              step={1}
              value={Number.isFinite(value.gapMinMinutes) ? value.gapMinMinutes : ''}
              onChange={(e) => change({ gapMinMinutes: numberOrNaN(e.target.value) })}
              aria-invalid={!!errors.gapMinMinutes || undefined}
            />
          </Field>
          <Field label="Maximum (minutes)" error={errors.gapMaxMinutes}>
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              max={MAX_GAP_MINUTES}
              step={1}
              value={Number.isFinite(value.gapMaxMinutes) ? value.gapMaxMinutes : ''}
              onChange={(e) => change({ gapMaxMinutes: numberOrNaN(e.target.value) })}
              aria-invalid={!!errors.gapMaxMinutes || undefined}
            />
          </Field>
        </div>
        <p className="text-xs text-ink-3">
          Every action (invite, message, profile visit, check) waits a random time in this range after the previous one. The default 1–5 minutes looks natural to LinkedIn.
        </p>
      </fieldset>

      <ScheduleLine settings={value} unsaved={dirty} />

      {formError && <Alert tone="bad">{formError}</Alert>}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={save.isPending} disabled={!dirty || Object.keys(clientErrors).length > 0}>
          Save active hours
        </Button>
        {dirty && (
          <Button
            type="button"
            variant="ghost"
            disabled={save.isPending}
            onClick={() => {
              setDraft(null)
              setServerErrors({})
              setFormError(null)
            }}
          >
            Discard changes
          </Button>
        )}
      </div>
    </form>
  )
}

/* ------------------------------ profile ------------------------------ */

function ProfileForm() {
  const { user } = useAuth()
  const update = useUpdateMe()
  const [name, setName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const value = name ?? user?.name ?? ''
  const dirty = name !== null && name.trim() !== user?.name

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) return setError('Enter your name')
    if (trimmed.length > 80) return setError('Name must be at most 80 characters')
    update.mutate(trimmed, {
      onSuccess: () => {
        setName(null)
        setError(null)
        toast('Profile saved', 'success')
      },
      onError: (err) => setError(detailsOf(err).name ?? errorMessage(err)),
    })
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" error={error}>
          <Input
            value={value}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
            autoComplete="name"
            maxLength={80}
            aria-invalid={!!error || undefined}
          />
        </Field>
        <Field label="Email" hint="Your sign-in email can’t be changed.">
          <Input value={user?.email ?? ''} readOnly aria-readonly className="cursor-not-allowed text-ink-2 focus:border-line focus:ring-0" />
        </Field>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-3">
          Workspace role: <Badge tone={user?.role === 'owner' ? 'brand' : user?.role === 'admin' ? 'info' : 'neutral'}>{user ? user.role[0].toUpperCase() + user.role.slice(1) : '–'}</Badge>
        </p>
        <Button type="submit" loading={update.isPending} disabled={!dirty}>
          Save profile
        </Button>
      </div>
    </form>
  )
}

function PasswordForm() {
  const { user } = useAuth()
  const change = useChangePassword()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const clearError = (k: string) =>
    setErrors((e) => {
      if (!e[k]) return e
      const next = { ...e }
      delete next[k]
      return next
    })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const errs: Record<string, string> = {}
    if (!current) errs.currentPassword = 'Enter your current password'
    if (next.length < 8) errs.newPassword = 'Password must be at least 8 characters'
    else if (next.length > 200) errs.newPassword = 'Password must be at most 200 characters'
    if (confirm !== next) errs.confirm = 'Passwords don’t match'
    setErrors(errs)
    setFormError(null)
    if (Object.keys(errs).length) return
    change.mutate(
      { currentPassword: current, newPassword: next },
      {
        onSuccess: () => {
          setCurrent('')
          setNext('')
          setConfirm('')
          toast('Password changed. Other devices were signed out.', 'success')
        },
        onError: (err) => {
          const details = detailsOf(err)
          setErrors(details)
          if (!details.currentPassword && !details.newPassword) setFormError(errorMessage(err))
        },
      },
    )
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4 border-t border-line pt-5">
      <h3 className="text-sm font-semibold">Change password</h3>
      {/* hidden username helps password managers update the right entry */}
      <input type="text" autoComplete="username" value={user?.email ?? ''} readOnly hidden />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Current password" error={errors.currentPassword}>
          <Input type="password" autoComplete="current-password" value={current} onChange={(e) => {
              setCurrent(e.target.value)
              clearError('currentPassword')
            }} aria-invalid={!!errors.currentPassword || undefined} />
        </Field>
        <Field label="New password" error={errors.newPassword} hint="At least 8 characters">
          <Input type="password" autoComplete="new-password" value={next} onChange={(e) => {
              setNext(e.target.value)
              clearError('newPassword')
            }} aria-invalid={!!errors.newPassword || undefined} />
        </Field>
        <Field label="Confirm new password" error={errors.confirm}>
          <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => {
              setConfirm(e.target.value)
              clearError('confirm')
            }} aria-invalid={!!errors.confirm || undefined} />
        </Field>
      </div>
      {formError && <Alert tone="bad">{formError}</Alert>}
      <div className="flex justify-end">
        <Button type="submit" variant="outline" loading={change.isPending} disabled={!current && !next && !confirm}>
          Change password
        </Button>
      </div>
    </form>
  )
}

/* ------------------------------ page ------------------------------ */

export default function Settings() {
  const { logout } = useAuth()
  const { hash } = useLocation()
  const linkedinReady = !useLinkedIn().isPending
  const settingsReady = !useSettings().isPending
  const scrolledFor = useRef<string | null>(null)

  // deep links like /settings#active-hours: scroll once the sections above have their final height
  useEffect(() => {
    if (!hash || !linkedinReady || !settingsReady || scrolledFor.current === hash) return
    const id = decodeURIComponent(hash.slice(1))
    const raf = requestAnimationFrame(() => {
      scrolledFor.current = hash
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    return () => cancelAnimationFrame(raf)
  }, [hash, linkedinReady, settingsReady])

  return (
    <>
      <PageHeader title="Settings" />
      <div className="space-y-6">
        <Section
          id="linkedin"
          title="LinkedIn account"
          description="Campaigns send connection requests, messages and follow-ups from this account. Use Test connection any time to check that LinkedIn still accepts the session."
        >
          <LinkedInConnect />
        </Section>

        <Section
          id="active-hours"
          title="Active hours"
          description={
            <>
              <span className="flex items-center gap-1.5">
                <Clock size={14} aria-hidden /> Applies to all your campaigns.
              </span>
              <span className="mt-1 block">
                LinkedIn actions only run inside this window, in your time zone. Outside it, campaigns wait and continue at the start of the next window.
              </span>
            </>
          }
        >
          <ActiveHours />
        </Section>

        <Section id="profile" title="Profile" description="Your name is shown to your team.">
          <ProfileForm />
          <PasswordForm />
        </Section>

        <Section id="sign-out" title="Sign out" description="Campaigns keep running on the server after you sign out.">
          <div>
            <Button variant="outline" onClick={() => void logout()}>
              <LogOut size={16} aria-hidden /> Sign out
            </Button>
          </div>
        </Section>
      </div>
    </>
  )
}
