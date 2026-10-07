import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import { Plus, Minus, Crosshair, Maximize2, Minimize2, Undo2, LayoutTemplate, AlertTriangle } from 'lucide-react'
import type { BranchKey, Sequence, StepKind } from '../../types'
import { deleteStep, insertStep, makeStep, updateStep, validateSequence, findParent } from '../../lib/sequence'
import { cn } from '../../lib/utils'
import { ConfirmModal } from '../ui'
import { SequenceContext, type SequenceCtx } from './context'
import { layoutSequence } from './layout'
import { AddNode, SeqEdgeView, StartNode, StepNode } from './nodes'
import { ActionPicker } from './ActionPicker'
import { StepEditor } from './StepEditor'
import { TemplateGrid, TemplatePicker } from './TemplatePicker'

const nodeTypes = { start: StartNode, step: StepNode, add: AddNode }
const edgeTypes = { seq: SeqEdgeView }
const MIN_FIT_ZOOM = 0.8

interface Props {
  sequence: Sequence
  onChange?: (s: Sequence) => void
  readOnly?: boolean
  leadCount: number
  listName?: string
  className?: string
}

function ToolButton({ onClick, label, children, disabled }: { onClick: () => void; label: string; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="grid size-12 cursor-pointer place-items-center text-ink transition-colors hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-35"
    >
      {children}
    </button>
  )
}

function Canvas({ sequence, onChange, readOnly = false, leadCount, listName = '', className }: Props) {
  const rf = useReactFlow()
  const containerRef = useRef<HTMLDivElement>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [adding, setAdding] = useState<{ parentId: string | null; branch: BranchKey } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const history = useRef<Sequence[]>([])

  const commit = useCallback(
    (next: Sequence) => {
      history.current = [...history.current.slice(-49), sequence]
      onChange?.(next)
    },
    [sequence, onChange],
  )

  const undo = () => {
    const prev = history.current.pop()
    if (prev) onChange?.(prev)
  }

  const { nodes, edges } = useMemo(
    () => layoutSequence(sequence, { readOnly, leadCount, listName }),
    [sequence, readOnly, leadCount, listName],
  )

  const issues = useMemo(() => validateSequence(sequence), [sequence])
  const issueIds = useMemo(() => new Set(issues.map((i) => i.stepId)), [issues])

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
      rf.setViewport({ x, y, zoom }, { duration })
    },
    [nodes, rf],
  )

  // Re-fit when the overall shape changes (step added / removed).
  const stepCount = Object.keys(sequence.steps).length
  const fitRef = useRef(fit)
  fitRef.current = fit
  useEffect(() => {
    const t = setTimeout(() => fitRef.current(0), 30)
    return () => clearTimeout(t)
  }, [stepCount])

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen()
    else containerRef.current?.requestFullscreen?.()
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
      readOnly,
      selectedId,
      issueIds,
      requestAdd: (parentId, branch) => setAdding({ parentId, branch }),
      select: setSelectedId,
      remove,
    }),
    [readOnly, selectedId, issueIds, remove],
  )

  const pick = (kind: StepKind) => {
    if (!adding) return
    const step = makeStep(kind)
    commit(insertStep(sequence, adding.parentId, adding.branch, step))
    setAdding(null)
    if (kind !== 'end' && kind !== 'view_profile' && kind !== 'follow' && kind !== 'like_post') setSelectedId(step.id)
  }

  // "End" only makes sense where there is nothing after the insertion point.
  const addingAtLeaf = adding
    ? (adding.parentId ? sequence.steps[adding.parentId]?.[adding.branch] : sequence.rootId) == null
    : false

  const selected = selectedId ? sequence.steps[selectedId] : null
  const isEmpty = !sequence.rootId

  return (
    <SequenceContext.Provider value={ctx}>
      <div ref={containerRef} className={cn('relative overflow-hidden rounded-2xl bg-panel-2/60', fullscreen ? 'h-screen' : 'h-[72vh] min-h-[520px]', className)}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          minZoom={0.2}
          maxZoom={1.5}
          // Supplying onNodeClick also keeps non-selectable nodes interactive (pointer-events).
          onNodeClick={(_, n) => n.type === 'step' && setSelectedId(n.id)}
          onPaneClick={() => setSelectedId(null)}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="var(--color-line-strong)" />

          <Panel position="top-right" className={cn(selected && 'hidden')}>
            <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-sidebar shadow-xl">
              <ToolButton label="Zoom in" onClick={() => rf.zoomIn({ duration: 200 })}><Plus size={20} /></ToolButton>
              <ToolButton label="Fit to screen" onClick={() => fit()}><Crosshair size={20} /></ToolButton>
              <ToolButton label="Zoom out" onClick={() => rf.zoomOut({ duration: 200 })}><Minus size={20} /></ToolButton>
              <div className="h-px bg-line" />
              <ToolButton label={fullscreen ? 'Exit full screen' : 'Full screen'} onClick={toggleFullscreen}>
                {fullscreen ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
              </ToolButton>
              {!readOnly && (
                <>
                  <div className="h-px bg-line" />
                  <ToolButton label="Undo" onClick={undo} disabled={!history.current.length}><Undo2 size={20} /></ToolButton>
                  <ToolButton label="Templates" onClick={() => setTemplatesOpen(true)}><LayoutTemplate size={20} /></ToolButton>
                </>
              )}
            </div>
          </Panel>

          {issues.length > 0 && !readOnly && (
            <Panel position="top-left">
              <div className="max-w-sm rounded-xl border border-bad/40 bg-sidebar p-3 text-sm shadow-xl">
                <p className="mb-1 flex items-center gap-2 font-semibold text-bad"><AlertTriangle size={16} /> {issues.length} step{issues.length > 1 ? 's' : ''} need attention</p>
                <ul className="space-y-0.5 text-xs text-ink-2">
                  {issues.slice(0, 4).map((i) => (
                    <li key={i.stepId + i.message}>
                      <button className="cursor-pointer text-left hover:text-ink" onClick={() => setSelectedId(i.stepId)}>• {i.message}</button>
                    </li>
                  ))}
                </ul>
              </div>
            </Panel>
          )}

          {isEmpty && !readOnly && (
            <Panel position="bottom-center" className="mb-8!">
              <div className="w-[min(640px,calc(100vw-4rem))] rounded-2xl border border-line bg-sidebar/95 p-5 shadow-2xl backdrop-blur">
                <p className="mb-1 font-semibold">Start with a template</p>
                <p className="mb-4 text-sm text-ink-2">Or press <span className="font-semibold text-ink">+</span> under “Campaign start” to build from scratch.</p>
                <TemplateGrid onPick={(t) => commit(t.build())} />
              </div>
            </Panel>
          )}
        </ReactFlow>

        {selected && (
          <StepEditor
            key={selected.id}
            step={selected}
            isFirst={findParent(sequence, selected.id)?.parentId === null}
            readOnly={readOnly}
            onClose={() => setSelectedId(null)}
            onChange={(patch) => onChange?.(updateStep(sequence, selected.id, patch))}
            onDelete={() => remove(selected.id)}
          />
        )}
      </div>

      <ActionPicker open={!!adding} allowEnd={addingAtLeaf} onClose={() => setAdding(null)} onPick={pick} />
      <TemplatePicker
        open={templatesOpen}
        onClose={() => setTemplatesOpen(false)}
        onPick={(t) => {
          commit(t.build())
          setSelectedId(null)
          setTemplatesOpen(false)
        }}
      />
      <ConfirmModal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="Delete condition?"
        body="Both the Yes and No branches below this condition will be deleted too."
        onConfirm={() => {
          if (!confirmDelete) return
          commit(deleteStep(sequence, confirmDelete))
          if (selectedId === confirmDelete) setSelectedId(null)
        }}
      />
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
