import { LayoutTemplate } from 'lucide-react'
import { SEQUENCE_TEMPLATES, type SequenceTemplate } from '../../lib/sequence'
import { Modal } from '../ui'

export function TemplateGrid({ onPick }: { onPick: (t: SequenceTemplate) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {SEQUENCE_TEMPLATES.map((t) => (
        <button
          key={t.id}
          onClick={() => onPick(t)}
          className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-panel p-4 text-left transition-colors hover:border-brand hover:bg-panel-2"
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand/15 text-brand">
            <LayoutTemplate size={18} />
          </span>
          <span>
            <span className="block font-semibold">{t.name}</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-ink-2">{t.description}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

export function TemplatePicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (t: SequenceTemplate) => void }) {
  return (
    <Modal open={open} onClose={onClose}>
      <h3 className="text-xl font-semibold">Sequence templates</h3>
      <p className="mb-6 mt-1 text-sm text-ink-2">Applying a template replaces the current sequence.</p>
      <TemplateGrid onPick={onPick} />
    </Modal>
  )
}
