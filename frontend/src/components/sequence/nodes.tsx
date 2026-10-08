import { BaseEdge, EdgeLabelRenderer, Handle, Position, getSmoothStepPath, type EdgeProps, type NodeProps, type Node } from '@xyflow/react'
import { Clock, Plus, Trash2, Users, AlertTriangle, ArrowRight, Sparkles } from 'lucide-react'
import type { SequenceStep } from '@shared/types.ts'
import { formatDelay, formatDuration } from '@shared/sequence.ts'
import { cn } from '../../lib/utils'
import { STEP_META, stepTitle } from '../../lib/sequence'
import { useSequenceCtx } from './context'
import { StepIcon, CHANNEL_STYLE } from './stepVisuals'
import { ADD_W, HINT_W, NODE_W, START_W, type AddNodeData, type SeqEdge, type StartNodeData, type StepNodeData } from './layout'

const hidden = { opacity: 0 }

export function StartNode({ data }: NodeProps<Node<StartNodeData, 'start'>>) {
  return (
    <div style={{ width: START_W }} className="rounded-2xl border border-ok/40 bg-panel px-5 py-4 shadow-lg">
      <div className="flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-lg bg-ok/15 text-ok" aria-hidden><Users size={18} /></span>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-ok">{data.title}</p>
          <p className="truncate text-sm font-medium" title={data.subtitle}>{data.subtitle}</p>
        </div>
      </div>
      <Handle type="source" id="next" position={Position.Bottom} style={hidden} />
    </div>
  )
}

function stepSubtitle(step: SequenceStep): { text: string; empty?: boolean } {
  const c = step.config ?? {}
  switch (step.kind) {
    case 'invite':
      return c.message?.trim() ? { text: `Note: ${c.message.trim()}` } : { text: 'Without a note' }
    case 'message':
      return c.message?.trim() ? { text: c.message.trim() } : { text: 'Write your message', empty: true }
    case 'condition':
      return { text: c.within ? `Keep checking for up to ${formatDuration(c.within)}` : 'Set how long to keep checking', empty: !c.within }
    case 'end':
      return { text: 'The sequence ends for this lead' }
    default:
      return { text: STEP_META[step.kind]?.description ?? '' }
  }
}

export function StepNode({ data }: NodeProps<Node<StepNodeData, 'step'>>) {
  const { selectedId, issueIds, remove, readOnly, select } = useSequenceCtx()
  const { step, index } = data
  const meta = STEP_META[step.kind] ?? STEP_META.condition
  const isCond = step.kind === 'condition'
  const selected = selectedId === step.id
  const hasIssue = issueIds.has(step.id)
  const title = stepTitle(step)
  const sub = stepSubtitle(step)

  return (
    <div
      style={{ width: NODE_W }}
      role="button"
      tabIndex={0}
      aria-label={`Step ${index}: ${title}${hasIssue ? ' (needs attention)' : ''}`}
      aria-pressed={selected}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          select(step.id)
        }
      }}
      className={cn(
        'group relative cursor-pointer rounded-2xl border bg-panel px-4 py-3.5 shadow-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
        selected ? 'border-brand ring-2 ring-brand/30' : hasIssue ? 'border-bad/70' : 'border-line-strong hover:border-ink-3',
      )}
    >
      <Handle type="target" position={Position.Top} style={hidden} />
      <div className="flex items-start gap-3">
        <StepIcon kind={step.kind} condition={step.config?.condition} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[15px] font-semibold">{title}</p>
            {hasIssue && <AlertTriangle size={14} className="shrink-0 text-bad" aria-hidden />}
          </div>
          <p className={cn('mt-0.5 line-clamp-2 text-xs leading-relaxed', sub.empty ? 'text-bad' : 'text-ink-2')}>{sub.text}</p>
        </div>
      </div>
      <span className={cn('absolute -top-2.5 left-4 rounded-full border bg-panel px-2 text-[10px] font-semibold uppercase tracking-wider', CHANNEL_STYLE[meta.channel].ring, CHANNEL_STYLE[meta.channel].fg)}>
        {isCond ? 'If' : CHANNEL_STYLE[meta.channel].label} · {index}
      </span>
      {!readOnly && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            remove(step.id)
          }}
          aria-label={`Delete step ${index}: ${title}`}
          title="Delete step"
          className={cn(
            'absolute -right-3 -top-3 size-7 cursor-pointer place-items-center rounded-full border border-line bg-sidebar text-ink-2 hover:text-bad focus-visible:grid',
            selected ? 'grid' : 'hidden group-hover:grid group-focus-within:grid',
          )}
        >
          <Trash2 size={14} />
        </button>
      )}
      {isCond ? (
        <>
          <Handle type="source" id="yes" position={Position.Bottom} style={{ ...hidden, left: '30%' }} />
          <Handle type="source" id="no" position={Position.Bottom} style={{ ...hidden, left: '70%' }} />
        </>
      ) : (
        <Handle type="source" id="next" position={Position.Bottom} style={hidden} />
      )}
    </div>
  )
}

export function AddNode({ data }: NodeProps<Node<AddNodeData, 'add'>>) {
  const { requestAdd } = useSequenceCtx()
  const label = data.first ? 'Add the first step' : data.branch === 'yes' ? 'Add a step to the Yes branch' : data.branch === 'no' ? 'Add a step to the No branch' : 'Add a step'
  return (
    <div style={{ width: ADD_W }} className="relative">
      <Handle type="target" position={Position.Top} style={hidden} />
      {data.first && <span className="pointer-events-none absolute inset-0 animate-ping rounded-full bg-brand/30" aria-hidden />}
      <button
        type="button"
        onClick={() => requestAdd(data.parentId, data.branch)}
        className={cn(
          'relative grid size-12 cursor-pointer place-items-center rounded-full border border-dashed bg-panel shadow-lg transition-colors hover:border-brand hover:bg-brand-soft hover:text-brand',
          data.first ? 'border-brand text-brand' : 'border-ink-3 text-ink-2',
        )}
        aria-label={label}
        title={label}
      >
        <Plus size={22} />
      </button>
    </div>
  )
}

const TYPICAL_FLOW = ['Send invite', 'If invite accepted', 'Send message', 'If replied (No)', 'Follow-up message']

/** Shown under the first "+" while the sequence is empty. */
export function HintNode() {
  const { requestAdd } = useSequenceCtx()
  return (
    <div style={{ width: HINT_W }} className="nodrag nopan cursor-default rounded-2xl border border-line bg-sidebar/95 p-5 shadow-2xl">
      <p className="flex items-center gap-2 font-semibold">
        <Sparkles size={18} className="text-brand" aria-hidden /> Build your own sequence
      </p>
      <p className="mt-1 text-sm text-ink-2">
        Press <span className="font-semibold text-ink">+</span> to add the first step. Typical flow:
      </p>
      <ol className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
        {TYPICAL_FLOW.map((s, i) => (
          <li key={s} className="flex items-center gap-1.5">
            <span className="rounded-full border border-line bg-panel px-2.5 py-1 font-medium text-ink-2">{s}</span>
            {i < TYPICAL_FLOW.length - 1 && <ArrowRight size={14} className="text-ink-3" aria-hidden />}
          </li>
        ))}
      </ol>
      <button
        type="button"
        onClick={() => requestAdd(null, 'next')}
        className="mt-4 inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg bg-brand px-3 text-sm font-semibold text-white hover:bg-brand-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <Plus size={16} aria-hidden /> Add the first step
      </button>
    </div>
  )
}

export function SeqEdgeView({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<SeqEdge>) {
  const { requestAdd, select, readOnly } = useSequenceCtx()
  const [path] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, borderRadius: 14, centerY: sourceY + 22 })
  const branch = data?.branch
  const delay = data?.delay && data.delay.max > 0 ? formatDelay(data.delay) : null
  const color = branch === 'yes' ? 'var(--color-ok)' : branch === 'no' ? 'var(--color-bad)' : 'var(--color-line-strong)'

  return (
    <>
      <BaseEdge id={id} path={path} style={{ stroke: color, strokeWidth: 2 }} />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-auto absolute flex items-center gap-1.5"
          // Branches turn right under the source; the label sits on the target's own vertical run, so Yes/No never collide.
          style={{ transform: `translate(-50%, -50%) translate(${targetX}px, ${(sourceY + 22 + targetY) / 2 + 2}px)` }}
        >
          {branch === 'yes' && <span className="rounded-full bg-ok/20 px-2 py-0.5 text-xs font-semibold text-ok">Yes</span>}
          {branch === 'no' && <span className="rounded-full bg-bad/20 px-2 py-0.5 text-xs font-semibold text-bad">No</span>}
          {delay && (
            <button
              type="button"
              onClick={() => data?.childId && select(data.childId)}
              title="Random wait before the next step – click to change"
              className="flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border border-line bg-sidebar px-2 py-0.5 text-xs text-ink-2 hover:text-ink"
            >
              <Clock size={12} aria-hidden /> {delay}
            </button>
          )}
          {!readOnly && data?.insertable && (
            <button
              type="button"
              onClick={() => requestAdd(data.parentId, data.branch)}
              aria-label="Insert a step here"
              title="Insert a step here"
              className="grid size-6 cursor-pointer place-items-center rounded-full border border-line bg-sidebar text-ink-2 hover:border-brand hover:text-brand"
            >
              <Plus size={14} />
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}
