import { RefreshCw, WifiOff } from 'lucide-react'
import { Button, Spinner } from '../components/ui'
import { LinkedInIcon } from '../components/ui/LinkedInIcon'

function LogoMark() {
  return (
    <span className="grid size-14 place-items-center rounded-2xl bg-brand text-white shadow-lg shadow-brand/20">
      <LinkedInIcon size={28} />
    </span>
  )
}

/** Shown while the session (GET /auth/me) resolves. */
export function FullScreenLoader({ label = 'Loading your workspace…' }: { label?: string }) {
  return (
    <div className="grid min-h-full place-items-center p-6" role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-5 text-center">
        <LogoMark />
        <div className="flex items-center gap-2.5 text-sm text-ink-2">
          <Spinner size={18} className="text-brand" />
          {label}
        </div>
      </div>
    </div>
  )
}

export function FullScreenError({ message, onRetry, onSignOut }: { message?: string; onRetry: () => void; onSignOut?: () => void }) {
  return (
    <div className="grid min-h-full place-items-center p-6">
      <div role="alert" className="flex max-w-sm flex-col items-center gap-4 text-center">
        <span className="grid size-14 place-items-center rounded-2xl bg-bad/15 text-bad">
          <WifiOff size={26} aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-semibold">Can’t load LinkPilot</h1>
          <p className="mt-2 text-sm text-ink-2">{message || 'The server didn’t respond. Check your connection and try again.'}</p>
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          <Button onClick={onRetry}>
            <RefreshCw size={16} /> Try again
          </Button>
          {onSignOut && (
            <Button variant="ghost" onClick={onSignOut}>
              Sign out
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
