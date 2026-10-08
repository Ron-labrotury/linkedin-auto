import { Link, useSearchParams } from 'react-router-dom'
import { ArrowRight, CalendarClock, Clock, Gauge, LogOut, PartyPopper, Shuffle, ShieldCheck } from 'lucide-react'
import { useAuth } from '../auth/context'
import { safeNext } from '../auth/links'
import { useLinkedIn, useSettings } from '../api/hooks-account'
import { Logo } from '../components/layout/Logo'
import { LinkedInConnect } from '../components/linkedin/LinkedInConnect'
import { describeDays } from '../components/linkedin/schedule'
import { Card } from '../components/ui'

/** First screen after sign-up: connect the LinkedIn account campaigns will send from. */
export default function Connect() {
  const { user, logout } = useAuth()
  const linkedin = useLinkedIn()
  const settings = useSettings().data
  const connected = linkedin.data?.status === 'connected'
  // the page the user wanted before signing in (Login passes it on), else the dashboard
  const [params] = useSearchParams()
  const next = safeNext(params.get('next')) ?? '/'
  const firstName = user?.name.split(/\s+/)[0] ?? ''

  const gap = settings ? `${settings.gapMinMinutes}–${settings.gapMaxMinutes} minutes` : '1–5 minutes'
  const hours = settings ? `${describeDays(settings.activeDays)}, ${settings.activeStart}–${settings.activeEnd} (${settings.timezone.replace(/_/g, ' ')})` : 'your working hours'

  const safety = [
    { icon: Shuffle, title: 'Random pauses', body: `Every action waits a random ${gap} after the previous one, like a person would.` },
    { icon: Gauge, title: 'Daily limits', body: 'Each campaign has its own daily caps, plus account-wide limits that keep you well inside LinkedIn’s.' },
    { icon: Clock, title: 'Active hours', body: `Actions only run during ${hours}.` },
    { icon: ShieldCheck, title: 'Private by design', body: 'Your password is never stored – only the encrypted LinkedIn session.' },
  ]

  return (
    <div className="min-h-full">
      <header className="border-b border-line/60 bg-sidebar/60">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <Logo />
          <div className="flex min-w-0 items-center gap-3 text-sm text-ink-2">
            <span className="hidden truncate sm:inline">{user?.email}</span>
            <button onClick={() => void logout()} className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 font-medium hover:bg-panel hover:text-ink">
              <LogOut size={16} aria-hidden /> Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="max-w-2xl">
          <p className="text-sm font-semibold uppercase tracking-wider text-brand">{connected ? 'All set' : 'Get started'}</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
            {connected ? 'Your LinkedIn account is connected' : `Welcome${firstName ? `, ${firstName}` : ''}! Connect your LinkedIn account`}
          </h1>
          <p className="mt-3 text-ink-2">
            {connected
              ? 'Campaigns will send connection requests and messages from this account. Next, build your first sequence.'
              : 'LinkPilot sends connection requests, messages and follow-ups from your own LinkedIn account. Connect it once – campaigns keep running on the server while you’re away.'}
          </p>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <Card className="p-5 sm:p-8">
            <LinkedInConnect />
            {connected && (
              <div className="mt-6 space-y-4 border-t border-line pt-6">
                <div className="flex items-start gap-3">
                  <PartyPopper size={20} className="mt-0.5 shrink-0 text-brand" aria-hidden />
                  <p className="text-sm text-ink-2">
                    Check your{' '}
                    <Link to="/settings#active-hours" className="font-medium text-brand hover:underline">
                      Active hours
                    </Link>{' '}
                    in Settings so actions run in your time zone{settings ? ` (currently ${hours})` : ''}.
                  </p>
                </div>
                <Link
                  to={next}
                  className="inline-flex h-12 items-center gap-2 rounded-lg bg-brand px-6 font-semibold text-white transition-colors hover:bg-brand-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                >
                  {next === '/' ? 'Continue to dashboard' : 'Continue'} <ArrowRight size={18} aria-hidden />
                </Link>
              </div>
            )}
          </Card>

          <aside aria-labelledby="safety-title" className="space-y-4">
            <h2 id="safety-title" className="flex items-center gap-2 text-sm font-semibold text-ink-2">
              <CalendarClock size={16} aria-hidden /> How LinkPilot keeps your account safe
            </h2>
            <ul className="space-y-3">
              {safety.map(({ icon: Icon, title, body }) => (
                <li key={title} className="flex gap-3 rounded-xl border border-line/60 bg-panel/60 p-4">
                  <Icon size={18} className="mt-0.5 shrink-0 text-brand" aria-hidden />
                  <div>
                    <p className="text-sm font-semibold">{title}</p>
                    <p className="mt-0.5 text-sm text-ink-2">{body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </aside>
        </div>

        {!connected && (
          <p className="mt-8 text-sm text-ink-3">
            Not ready yet?{' '}
            <Link to={next} className="font-medium text-ink-2 underline-offset-2 hover:text-ink hover:underline">
              Skip for now
            </Link>{' '}
            – you can build campaigns first; they wait until LinkedIn is connected.
          </p>
        )}
      </main>
    </div>
  )
}
