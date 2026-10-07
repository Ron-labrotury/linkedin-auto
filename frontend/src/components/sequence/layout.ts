import type { Edge, Node } from '@xyflow/react'
import type { BranchKey, Sequence, SequenceStep } from '../../types'

export const NODE_W = 280
export const ADD_W = 48
export const START_W = 300
const COL = 330
const ROW = 185

export type StartNodeData = { leadCount: number; listName: string; hasRoot: boolean }
export type StepNodeData = { step: SequenceStep; index: number }
export type AddNodeData = { parentId: string | null; branch: BranchKey }
export type SeqEdgeData = { branch: BranchKey; delayDays?: number; delayHours?: number; childId?: string; parentId: string | null; insertable: boolean }

export type SeqNode =
  | Node<StartNodeData, 'start'>
  | Node<StepNodeData, 'step'>
  | Node<AddNodeData, 'add'>

export type SeqEdge = Edge<SeqEdgeData, 'seq'>

/**
 * Tree layout: every subtree gets a width in "columns"; conditions place their
 * Yes branch on the left and No branch on the right.
 */
export function layoutSequence(
  seq: Sequence,
  opts: { readOnly: boolean; leadCount: number; listName: string },
): { nodes: SeqNode[]; edges: SeqEdge[] } {
  const nodes: SeqNode[] = []
  const edges: SeqEdge[] = []
  const widthCache = new Map<string, number>()
  let counter = 0

  const widthOf = (id: string | null | undefined): number => {
    if (!id || !seq.steps[id]) return 1
    if (widthCache.has(id)) return widthCache.get(id)!
    const s = seq.steps[id]
    const w = s.kind === 'condition' ? widthOf(s.yes) + widthOf(s.no) : s.kind === 'end' ? 1 : widthOf(s.next)
    widthCache.set(id, w)
    return w
  }

  const placeChild = (
    childId: string | null | undefined,
    parentId: string | null,
    parentNodeId: string,
    branch: BranchKey,
    x0: number,
    depth: number,
  ) => {
    const w = widthOf(childId)
    const cx = x0 + (w * COL) / 2
    const y = depth * ROW
    const child = childId ? seq.steps[childId] : undefined
    if (child) {
      edges.push({
        id: `e_${parentNodeId}_${branch}`,
        source: parentNodeId,
        target: child.id,
        sourceHandle: branch,
        type: 'seq',
        data: { branch, delayDays: child.delay.days, delayHours: child.delay.hours, childId: child.id, parentId, insertable: !opts.readOnly },
      })
      place(child, x0, depth)
    } else if (!opts.readOnly) {
      const addId = `add_${parentNodeId}_${branch}`
      nodes.push({ id: addId, type: 'add', position: { x: cx - ADD_W / 2, y: y + 20 }, data: { parentId, branch }, draggable: false })
      edges.push({ id: `e_${addId}`, source: parentNodeId, target: addId, sourceHandle: branch, type: 'seq', data: { branch, parentId, insertable: false } })
    }
  }

  const place = (s: SequenceStep, x0: number, depth: number) => {
    const w = widthOf(s.id)
    const cx = x0 + (w * COL) / 2
    nodes.push({ id: s.id, type: 'step', position: { x: cx - NODE_W / 2, y: depth * ROW }, data: { step: s, index: ++counter }, draggable: false })
    if (s.kind === 'condition') {
      placeChild(s.yes, s.id, s.id, 'yes', x0, depth + 1)
      placeChild(s.no, s.id, s.id, 'no', x0 + widthOf(s.yes) * COL, depth + 1)
    } else if (s.kind !== 'end') {
      placeChild(s.next, s.id, s.id, 'next', x0, depth + 1)
    }
  }

  const total = widthOf(seq.rootId)
  nodes.push({
    id: 'start',
    type: 'start',
    position: { x: (total * COL) / 2 - START_W / 2, y: 0 },
    data: { leadCount: opts.leadCount, listName: opts.listName, hasRoot: !!seq.rootId },
    draggable: false,
  })
  placeChild(seq.rootId, null, 'start', 'next', 0, 1)

  return { nodes, edges }
}
