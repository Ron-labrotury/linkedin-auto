import type { StepKind } from '../../types'
import { ACTION_GROUPS, STEP_META } from '../../lib/sequence'
import { Modal } from '../ui'
import { StepIcon } from './stepVisuals'

export function ActionPicker({
  open,
  onClose,
  onPick,
  allowEnd,
}: {
  open: boolean
  onClose: () => void
  onPick: (kind: StepKind) => void
  allowEnd: boolean
}) {
  const groups = allowEnd ? [...ACTION_GROUPS, { title: 'Finish', kinds: ['end' as const] }] : ACTION_GROUPS
  return (
    <Modal open={open} onClose={onClose} className="max-w-3xl">
      <h3 className="text-xl font-semibold">Add a step</h3>
      <p className="mt-1 text-sm text-ink-2">Pick what should happen next for each lead.</p>
      <div className="mt-6 max-h-[60vh] space-y-6 overflow-y-auto pr-1">
        {groups.map((g) => (
          <section key={g.title}>
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-3">{g.title}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {g.kinds.map((k) => (
                <button
                  key={k}
                  onClick={() => onPick(k)}
                  className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-panel p-4 text-left transition-colors hover:border-brand hover:bg-panel-2"
                >
                  <StepIcon kind={k} />
                  <span>
                    <span className="block font-semibold">{STEP_META[k].label}</span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-ink-2">{STEP_META[k].description}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Modal>
  )
}
