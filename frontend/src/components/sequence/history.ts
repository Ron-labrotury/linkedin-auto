/** Undo history of the sequence builder. Pure (tested in sequence.test.ts). */

export const HISTORY_LIMIT = 50

export interface UndoHistory<T> {
  /** Remember `current` before a structural change (a step added or deleted). */
  recordChange(current: T): void
  /**
   * Remember `current` before an edit of step `stepId` (message, wait, condition …). Consecutive edits
   * of the same step share one entry, so undo steps back over a whole edit, not every keystroke.
   */
  recordEdit(current: T, stepId: string): void
  /** The value to go back to, or undefined when there is nothing to undo. */
  undo(): T | undefined
  readonly size: number
}

export function createUndoHistory<T>(limit = HISTORY_LIMIT): UndoHistory<T> {
  let stack: T[] = []
  let editing: string | null = null
  const push = (value: T) => {
    stack = [...stack.slice(-(limit - 1)), value]
  }
  return {
    recordChange(current) {
      push(current)
      editing = null
    },
    recordEdit(current, stepId) {
      if (editing === stepId) return
      push(current)
      editing = stepId
    },
    undo() {
      editing = null
      return stack.pop()
    },
    get size() {
      return stack.length
    },
  }
}
