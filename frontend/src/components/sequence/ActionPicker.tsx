import type { ConditionKind, StepKind } from '@shared/types.ts'
import { ACTION_GROUPS, CONDITION_META, CONDITION_ORDER, STEP_META } from '../../lib/sequence'
import { Modal } from '../ui'
import { StepIcon } from './stepVisuals'

function Choice({ kind, condition, title, body, onClick }: { kind: StepKind; condition?: ConditionKind; title: string; body: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-panel p-4 text-left transition-colors hover:border-brand hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-brand"
    >
      <StepIcon kind={kind} condition={condition} />
      <span>
        <span className="block font-semibold">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-ink-2">{body}</span>
      </span>
    </button>
  )
}

export function ActionPicker({
  open,
  onClose,
  onPick,
  allowEnd,
}: {
  open: boolean
  onClose: () => void
  onPick: (kind: StepKind, condition?: ConditionKind) => void
  allowEnd: boolean
}) {
  return (
    <Modal open={open} onClose={onClose} className="max-w-3xl">
      <h3 className="pr-8 text-xl font-semibold">Add a step</h3>
      <p className="mt-1 text-sm text-ink-2">Pick what should happen next for each lead.</p>
      <div className="mt-6 max-h-[65vh] space-y-6 overflow-y-auto pr-1">
        {ACTION_GROUPS.map((g) => (
          <section key={g.title}>
            <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-3">{g.title}</h4>
            <div className="grid gap-3 sm:grid-cols-2">
              {g.kinds.map((k) => (
                <Choice key={k} kind={k} title={STEP_META[k].label} body={STEP_META[k].description} onClick={() => onPick(k)} />
              ))}
            </div>
          </section>
        ))}
        <section>
          <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-3">Conditions (Yes / No)</h4>
          <div className="grid gap-3 sm:grid-cols-2">
            {CONDITION_ORDER.map((c) => (
              <Choice key={c} kind="condition" condition={c} title={CONDITION_META[c].label} body={CONDITION_META[c].description} onClick={() => onPick('condition', c)} />
            ))}
          </div>
        </section>
        {allowEnd && (
          <section>
            <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-3">Finish</h4>
            <div className="grid gap-3 sm:grid-cols-2">
              <Choice kind="end" title={STEP_META.end.label} body={STEP_META.end.description} onClick={() => onPick('end')} />
            </div>
          </section>
        )}
      </div>
    </Modal>
  )
}
