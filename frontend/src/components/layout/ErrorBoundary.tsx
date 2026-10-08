import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { Button } from '../ui'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/** Keeps a crashing page (or a chunk that failed to load after a deploy) from blanking the whole app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ui] page crashed', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const chunk = /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(error.message)
    return (
      <div role="alert" className="mx-auto flex max-w-md flex-col items-center gap-4 py-20 text-center">
        <span className="grid size-14 place-items-center rounded-2xl bg-bad/15 text-bad">
          <AlertCircle size={26} aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-semibold">{chunk ? 'A new version is available' : 'Something went wrong on this page'}</h1>
          <p className="mt-2 text-sm text-ink-2">
            {chunk ? 'Reload to get the latest version of LinkPilot.' : 'Your data is safe. Reload the page, and if it keeps happening try again in a few minutes.'}
          </p>
          {!chunk && <p className="mt-3 break-words font-mono text-xs text-ink-3">{error.message}</p>}
        </div>
        <Button onClick={() => window.location.reload()}>
          <RefreshCw size={16} /> Reload
        </Button>
      </div>
    )
  }
}
