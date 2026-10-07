import { BaseEdge, EdgeLabelRenderer, Handle, Position, getSmoothStepPath, type EdgeProps, type NodeProps, type Node } from '@xyflow/react'
import { Clock, Plus, Trash2, Users, AlertTriangle } from 'lucide-react'
import { cn } from '../../lib/utils'
import { CONDITION_META, STEP_META } from '../../lib/sequence'
import { useSequenceCtx } from './context'
import { StepIcon, CHANNEL_STYLE } from './stepVisuals'
import { ADD_W, NODE_W, START_W, type AddNodeData, type SeqEdge, type StartNodeData, type StepNodeData } from './layout'

const hidden = { opacity: 0 }

export function StartNode({ data }: NodeProps<Node<StartNodeData, 'start'>>) {
  return (
    <div style={{ width: START_W }} className="rounded-2xl border border-ok/40 bg-panel px-5 py-4 shadow-lg">
      <div className="flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-lg bg-ok/15 text-ok"><Users size={18} /></span>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-ok">Campaign start</p>
          <p className="truncate text-sm font-medium">
            {data.leadCount} leads{data.listName ? ` · ${data.listName}` : ''}
          </p>
        </div>
      </div>
      <Handle type="source" id="next" position={Position.Bottom} style={hidden} />
    </div>
  )
}

function stepSubtitle(data: StepNodeData) {
  const { step } = data
  const c = step.config
  switch (step.kind) {
    case 'invite':
      return c.message?.trim() ? `Note: ${c.message}` : 'Without a note'
    case 'message':
      return c.message?.trim() || 'Message is empty'
    case 'email':
      return c.subject?.trim() ? `Subject: ${c.subject}` : 'Subject is empty'
    case 'endorse':
      return `Endorse ${c.skillsCount ?? 3} skills`
    case 'condition':
      return `${CONDITION_META[c.condition ?? 'accepted_invite'].question} Wait up to ${c.withinDays ?? 0}d`
    default:
      return STEP_META[step.kind].description
  }
}

export function StepNode({ data }: NodeProps<Node<StepNodeData, 'step'>>) {
  const { selectedId, issueIds, remove, readOnly } = useSequenceCtx()
  const { step } = data
  const meta = STEP_META[step.kind]
  const isCond = step.kind === 'condition'
  const selected = selectedId === step.id
  const hasIssue = issueIds.has(step.id)

  return (
    <div
      style={{ width: NODE_W }}
      className={cn(
        'group relative cursor-pointer rounded-2xl border bg-panel px-4 py-3.5 shadow-lg transition-colors',
        selected ? 'border-brand ring-2 ring-brand/30' : hasIssue ? 'border-bad/70' : 'border-line-strong hover:border-ink-3',
      )}
    >
      <Handle type="target" position={Position.Top} style={hidden} />
      <div className="flex items-start gap-3">
        <StepIcon kind={step.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[15px] font-semibold">
              {isCond ? CONDITION_META[step.config.condition ?? 'accepted_invite'].label : meta.label}
            </p>
            {hasIssue && <AlertTriangle size={14} className="shrink-0 text-bad" aria-label="Needs attention" />}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-ink-2">{stepSubtitle(data)}</p>
        </div>
      </div>
      <span className={cn('absolute -top-2.5 left-4 rounded-full border bg-panel px-2 text-[10px] font-semibold uppercase tracking-wider', CHANNEL_STYLE[meta.channel].ring, CHANNEL_STYLE[meta.channel].fg)}>
        {isCond ? 'If' : CHANNEL_STYLE[meta.channel].label}
      </span>
      {!readOnly && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            remove(step.id)
          }}
          aria-label={`Delete ${meta.label}`}
          className="absolute -right-3 -top-3 hidden size-7 cursor-pointer place-items-center rounded-full border border-line bg-sidebar text-ink-2 hover:text-bad group-hover:grid"
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
  return (
    <div style={{ width: ADD_W }}>
      <Handle type="target" position={Position.Top} style={hidden} />
      <button
        onClick={() => requestAdd(data.parentId, data.branch)}
        className="grid size-12 cursor-pointer place-items-center rounded-full border border-dashed border-ink-3 bg-panel text-ink-2 shadow-lg transition-colors hover:border-brand hover:bg-brand-soft hover:text-brand"
        aria-label="Add step"
        title="Add step"
      >
        <Plus size={22} />
      </button>
    </div>
  )
}

function delayLabel(d?: number, h?: number) {
  if (!d && !h) return null
  const parts = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  return `Wait ${parts.join(' ')}`
}

export function SeqEdgeView({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<SeqEdge>) {
  const { requestAdd, select, readOnly } = useSequenceCtx()
  const [path] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, borderRadius: 14, centerY: sourceY + 22 })
  const branch = data?.branch
  const delay = delayLabel(data?.delayDays, data?.delayHours)
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
              onClick={() => data?.childId && select(data.childId)}
              className="flex cursor-pointer items-center gap-1 rounded-full border border-line bg-sidebar px-2 py-0.5 text-xs text-ink-2 hover:text-ink"
            >
              <Clock size={12} /> {delay}
            </button>
          )}
          {!readOnly && data?.insertable && (
            <button
              onClick={() => requestAdd(data.parentId, data.branch)}
              aria-label="Insert step here"
              title="Insert step here"
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
