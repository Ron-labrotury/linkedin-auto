import { createContext, useContext } from 'react'
import type { BranchKey } from '../../types'

export interface SequenceCtx {
  readOnly: boolean
  selectedId: string | null
  issueIds: Set<string>
  requestAdd: (parentId: string | null, branch: BranchKey) => void
  select: (id: string | null) => void
  remove: (id: string) => void
}

export const SequenceContext = createContext<SequenceCtx | null>(null)

export function useSequenceCtx() {
  const ctx = useContext(SequenceContext)
  if (!ctx) throw new Error('useSequenceCtx must be used inside SequenceContext')
  return ctx
}
