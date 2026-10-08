import { useCallback, useEffect, useRef } from 'react'
import { useBlocker, type BlockerFunction } from 'react-router-dom'
import { Button, Modal } from '../ui'

/**
 * Asks before unsaved work is lost: an in-app navigation (links, sidebar, back button) to another page
 * opens a dialog; closing or reloading the tab shows the browser's own prompt.
 * Render `dialog` somewhere in the page. Call `allowLeave()` right before a deliberate navigation
 * (after saving, after deleting) so it isn't blocked.
 */
export function useUnsavedChangesGuard(dirty: boolean, text: { title?: string; body?: string } = {}) {
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const allowed = useRef(false)

  useEffect(() => {
    if (!dirty) return
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!allowed.current) e.preventDefault()
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [dirty])

  // Refs keep the check current even for a navigate() called right after a state change.
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) => dirtyRef.current && !allowed.current && currentLocation.pathname !== nextLocation.pathname,
    [],
  )
  const blocker = useBlocker(shouldBlock)

  const stay = () => {
    if (blocker.state === 'blocked') blocker.reset()
  }
  // Never reset() after proceed(): a blocked back/forward is re-run asynchronously and would be blocked again.
  const leave = () => {
    if (blocker.state === 'blocked') blocker.proceed()
  }

  const dialog = (
    <Modal open={blocker.state === 'blocked'} onClose={stay} className="max-w-md">
      <h3 className="pr-8 text-lg font-semibold">{text.title ?? 'Leave without saving?'}</h3>
      <p className="mt-2 text-sm text-ink-2">{text.body ?? 'Your changes on this page haven’t been saved yet. If you leave now, they are lost.'}</p>
      <div className="mt-6 flex flex-wrap justify-end gap-3">
        <Button variant="outline" onClick={stay} autoFocus>
          Stay on this page
        </Button>
        <Button variant="danger" onClick={leave}>
          Leave and discard
        </Button>
      </div>
    </Modal>
  )

  const allowLeave = useCallback(() => {
    allowed.current = true
  }, [])

  return { dialog, allowLeave }
}
