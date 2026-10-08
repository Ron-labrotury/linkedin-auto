import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Background, BackgroundVariant, Panel, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { Plus, Minus, Crosshair, Maximize2, Minimize2, Undo2, AlertTriangle } from 'lucide-react'
import type { BranchKey, ConditionKind, Sequence, SequenceStep, StepKind } from '@shared/types.ts'
import { deleteStep, findParent, insertStep, makeStep, updateStep, validateSequence } from '@shared/sequence.ts'
import { hasRunnableStep, repliedYesBranchSteps, stepNumbers } from '../../lib/sequence'
import { cn } from '../../lib/utils'
import { ConfirmModal } from '../ui'
import { SequenceContext, type SequenceCtx } from './context'
import { NODE_W, layoutSequence } from './layout'
import { AddNode, HintNode, SeqEdgeView, StartNode, StepNode } from './nodes'
import { ActionPicker } from './ActionPicker'
import { StepEditor } from './StepEditor'
import { createUndoHistory } from './history'

const nodeTypes = { start: StartNode, step: StepNode, add: AddNode, hint: HintNode }
const edgeTypes = { seq: SeqEdgeView }
const MIN_FIT_ZOOM = 0.8
interface Props {
  sequence: Sequence
  onChange?: (s: Sequence) => void
  readOnly?: boolean
  /** Second line of the "Campaign start" card, e.g. "120 leads · Pune CTOs". */
  startSubtitle: string
  /** The campaign's "Stop the sequence when a lead replies" setting: steps on the Yes branch of "If replied" then never run. */
  stopOnReply?: boolean
  className?: string
}

function ToolButton({ onClick, label, children, disabled }: { onClick: () => void; label: string; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="grid size-11 cursor-pointer place-items-center text-ink transition-colors hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-35 sm:size-12"
    >
      {children}
    </button>
  )
}

function Canvas({ sequence, onChange, readOnly = false, startSubtitle, stopOnReply = false, className }: Props) {
  const rf = useReactFlow()
  const containerRef = useRef<HTMLDivElement>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [adding, setAdding] = useState<{ parentId: string | null; branch: BranchKey } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  // Structural changes and step edits (coalesced per step) both go into the history, so undo never
  // silently reverts an edit made after the last added / deleted step.
  const [history] = useState(() => createUndoHistory<Sequence>())
  const editable = !readOnly && !!onChange

  const commit = useCallback(
    (next: Sequence) => {
      history.recordChange(sequence)
      onChange?.(next)
    },
    [history, sequence, onChange],
  )

  const editStep = (id: string, patch: Partial<SequenceStep>) => {
    if (!onChange) return
    history.recordEdit(sequence, id)
    onChange(updateStep(sequence, id, patch))
  }

  const undo = useCallback(() => {
    const prev = history.undo()
    if (prev) onChange?.(prev)
  }, [history, onChange])

  const { nodes, edges } = useMemo(
    () => layoutSequence(sequence, { readOnly: !editable, startTitle: 'Campaign start', startSubtitle }),
    [sequence, editable, startSubtitle],
  )
  const numbers = useMemo(() => stepNumbers(sequence), [sequence])
  const issues = useMemo(() => validateSequence(sequence), [sequence])
  const issueIds = useMemo(() => new Set(issues.flatMap((i) => (i.stepId ? [i.stepId] : []))), [issues])
  const deadYesBranches = useMemo(() => (stopOnReply ? repliedYesBranchSteps(sequence) : []), [stopOnReply, sequence])

  /**
   * Fit the whole tree when it is small; for large trees keep text readable
   * (zoom >= MIN_FIT_ZOOM) and anchor the view at the top, like reading a flow.
   */
  const fit = useCallback(
    (duration = 300) => {
      const el = containerRef.current
      if (!el || !nodes.length) return
      const b = rf.getNodesBounds(nodes.map((n) => n.id))
      const w = el.clientWidth
      const h = el.clientHeight
      const pad = 48
      let zoom = Math.min(1, (w - pad * 2) / b.width, (h - pad * 2) / b.height)
      const fitsAll = zoom >= MIN_FIT_ZOOM
      if (!fitsAll) zoom = MIN_FIT_ZOOM
      const x = w / 2 - (b.x + b.width / 2) * zoom
      const y = fitsAll ? h / 2 - (b.y + b.height / 2) * zoom : pad - b.y * zoom
      void rf.setViewport({ x, y, zoom }, { duration })
    },
    [nodes, rf],
  )

  // Re-fit when the overall shape changes (step added / removed) or the canvas resizes.
  const stepCount = Object.keys(sequence.steps).length
  const fitRef = useRef(fit)
  fitRef.current = fit
  useEffect(() => {
    const t = setTimeout(() => fitRef.current(0), 30)
    return () => clearTimeout(t)
  }, [stepCount, fullscreen])

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === containerRef.current)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  // Keep the selected step visible next to the editor panel (desktop widths only); runs after the re-fit above.
  useEffect(() => {
    if (!selectedId) return
    const t = setTimeout(() => {
      const el = containerRef.current
      const node = rf.getNode(selectedId)
      if (!el || !node) return
      const free = el.clientWidth - Math.min(448, el.clientWidth)
      if (free < 320) return
      const { x, y, zoom } = rf.getViewport()
      const left = node.position.x * zoom + x
      const top = node.position.y * zoom + y
      if (left >= 16 && left + NODE_W * zoom <= free - 16 && top >= 16 && top <= el.clientHeight - 120) return
      void rf.setViewport({ x: free / 2 - (node.position.x + NODE_W / 2) * zoom, y: el.clientHeight / 2 - (node.position.y + 40) * zoom, zoom }, { duration: 300 })
    }, 80)
    return () => clearTimeout(t)
  }, [selectedId, stepCount, rf])

  // Ctrl/Cmd+Z undoes the last change when no text field has focus (text fields keep their own undo).
  useEffect(() => {
    if (!editable) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
      if (!containerRef.current?.contains(t) && t !== document.body) return
      e.preventDefault()
      undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editable, undo])

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void containerRef.current?.requestFullscreen?.()
  }

  const remove = useCallback(
    (id: string) => {
      const s = sequence.steps[id]
      if (!s) return
      if (s.kind === 'condition' && (s.yes || s.no)) setConfirmDelete(id)
      else {
        commit(deleteStep(sequence, id))
        if (selectedId === id) setSelectedId(null)
      }
    },
    [sequence, commit, selectedId],
  )

  const ctx: SequenceCtx = useMemo(
    () => ({
      readOnly: !editable,
      selectedId,
      issueIds,
      requestAdd: (parentId, branch) => setAdding({ parentId, branch }),
      select: setSelectedId,
      remove,
    }),
    [editable, selectedId, issueIds, remove],
  )

  const pick = (kind: StepKind, condition?: ConditionKind) => {
    if (!adding) return
    const step = makeStep(kind)
    if (kind === 'condition' && condition) step.config = { ...step.config, condition }
    commit(insertStep(sequence, adding.parentId, adding.branch, step))
    setAdding(null)
    if (kind === 'invite' || kind === 'message' || kind === 'condition') setSelectedId(step.id)
  }

  // "End" only makes sense where there is nothing after the insertion point.
  const addingAtLeaf = adding ? (adding.parentId ? sequence.steps[adding.parentId]?.[adding.branch] : sequence.rootId) == null : false

  const selected = selectedId ? sequence.steps[selectedId] : null
  const isEmpty = !sequence.rootId

  return (
    <SequenceContext.Provider value={ctx}>
      <div
        ref={containerRef}
        className={cn('relative overflow-hidden rounded-2xl bg-panel-2/60', fullscreen ? 'h-screen rounded-none bg-bg' : 'h-[72vh] min-h-[480px]', className)}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          minZoom={0.2}
          maxZoom={1.5}
          // Supplying onNodeClick also keeps non-selectable nodes interactive (pointer-events).
          onNodeClick={(_, n) => n.type === 'step' && setSelectedId(n.id)}
          onPaneClick={() => setSelectedId(null)}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="var(--color-line-strong)" />

          <Panel position="top-right" className={cn(selected && 'hidden')}>
            <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-sidebar shadow-xl" role="toolbar" aria-label="Canvas controls">
              <ToolButton label="Zoom in" onClick={() => void rf.zoomIn({ duration: 200 })}><Plus size={20} /></ToolButton>
              <ToolButton label="Fit to screen" onClick={() => fit()}><Crosshair size={20} /></ToolButton>
              <ToolButton label="Zoom out" onClick={() => void rf.zoomOut({ duration: 200 })}><Minus size={20} /></ToolButton>
              <div className="h-px bg-line" />
              <ToolButton label={fullscreen ? 'Exit full screen' : 'Full screen'} onClick={toggleFullscreen}>
                {fullscreen ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
              </ToolButton>
              {editable && (
                <>
                  <div className="h-px bg-line" />
                  <ToolButton label="Undo" onClick={undo} disabled={!history.size}><Undo2 size={20} /></ToolButton>
                </>
              )}
            </div>
          </Panel>

          {((issues.length > 0 && editable) || deadYesBranches.length > 0) && !selected && (
            <Panel position="top-left" className="max-w-[calc(100%-6rem)] space-y-2">
              {issues.length > 0 && editable && (
                <div className="max-w-sm rounded-xl border border-bad/40 bg-sidebar p-3 text-sm shadow-xl" role="status">
                  <p className="mb-1 flex items-center gap-2 font-semibold text-bad">
                    <AlertTriangle size={16} aria-hidden /> {issues.length === 1 ? '1 problem to fix' : `${issues.length} problems to fix`}
                  </p>
                  <ul className="space-y-0.5 text-xs text-ink-2">
                    {issues.slice(0, 4).map((i, n) => (
                      <li key={`${i.stepId}-${n}`}>
                        {i.stepId && sequence.steps[i.stepId] ? (
                          <button type="button" className="cursor-pointer text-left hover:text-ink hover:underline" onClick={() => setSelectedId(i.stepId)}>
                            Step {numbers.get(i.stepId) ?? '?'}: {i.message}
                          </button>
                        ) : (
                          <span>{i.message}</span>
                        )}
                      </li>
                    ))}
                    {issues.length > 4 && <li>…and {issues.length - 4} more</li>}
                  </ul>
                </div>
              )}
              {deadYesBranches.length > 0 && (
                <div className="max-w-sm rounded-xl border border-warn/40 bg-sidebar p-3 text-sm shadow-xl" role="status">
                  <p className="mb-1 flex items-center gap-2 font-semibold text-warn">
                    <AlertTriangle size={16} aria-hidden /> Yes branch won’t run
                  </p>
                  <p className="text-xs text-ink-2">
                    “Stop the sequence when a lead replies” is on in the campaign settings, so a reply ends the sequence for that lead. Steps on the Yes branch of{' '}
                    {deadYesBranches.map((id, n) => (
                      <span key={id}>
                        {n > 0 && ', '}
                        <button type="button" className="cursor-pointer font-medium text-ink hover:underline" onClick={() => setSelectedId(id)}>
                          step {numbers.get(id) ?? '?'}
                        </button>
                      </span>
                    ))}{' '}
                    (“If replied”) never run. Turn the setting off if they should.
                  </p>
                </div>
              )}
            </Panel>
          )}

          {isEmpty && !editable && (
            <Panel position="bottom-center" className="mb-6!">
              <p className="rounded-xl border border-line bg-sidebar px-4 py-3 text-sm text-ink-2 shadow-xl">This sequence has no steps yet.</p>
            </Panel>
          )}
        </ReactFlow>

        {selected && (
          <StepEditor
            key={selected.id}
            step={selected}
            index={numbers.get(selected.id) ?? 0}
            isFirst={findParent(sequence, selected.id)?.parentId === null}
            readOnly={!editable}
            onClose={() => setSelectedId(null)}
            onChange={(patch) => editStep(selected.id, patch)}
            stopOnReply={stopOnReply}
            yesBranchHasSteps={hasRunnableStep(sequence, selected.yes)}
            onDelete={() => remove(selected.id)}
          />
        )}

        {/* Dialogs live inside the container so they stay visible in full-screen mode. */}
        <ActionPicker open={!!adding} allowEnd={addingAtLeaf} onClose={() => setAdding(null)} onPick={pick} />
        <ConfirmModal
          open={!!confirmDelete}
          onClose={() => setConfirmDelete(null)}
          title="Delete this condition?"
          body="Both the Yes and the No branch below this condition will be deleted too. You can undo this."
          onConfirm={() => {
            if (!confirmDelete) return
            commit(deleteStep(sequence, confirmDelete))
            if (selectedId === confirmDelete) setSelectedId(null)
          }}
        />
      </div>
    </SequenceContext.Provider>
  )
}

export function SequenceCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  )
}
