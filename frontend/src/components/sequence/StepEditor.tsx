import { useRef } from 'react'
import { X, Trash2 } from 'lucide-react'
import type { ConditionKind, SequenceStep } from '../../types'
import { CONDITION_META, INVITE_NOTE_LIMIT, SAMPLE_VARS, STEP_META, TEMPLATE_VARIABLES } from '../../lib/sequence'
import { cn, renderTemplate } from '../../lib/utils'
import { Button, Field, Input, Select, Textarea } from '../ui'
import { StepIcon } from './stepVisuals'

function MessageField({
  label,
  value,
  onChange,
  limit,
  rows = 6,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  limit?: number
  rows?: number
  placeholder?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const insert = (v: string) => {
    const el = ref.current
    const token = `{{${v}}}`
    if (!el) return onChange(value + token)
    const start = el.selectionStart ?? value.length
    const end = el.selectionEnd ?? value.length
    const next = value.slice(0, start) + token + value.slice(end)
    onChange(next)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + token.length, start + token.length)
    })
  }
  const over = limit !== undefined && value.length > limit
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-ink-2">{label}</span>
        {limit !== undefined && (
          <span className={cn('text-xs tabular-nums', over ? 'font-semibold text-bad' : 'text-ink-3')}>
            {value.length}/{limit}
          </span>
        )}
      </div>
      <Textarea ref={ref} rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={cn(over && 'border-bad')} />
      <div className="flex flex-wrap gap-1.5">
        {TEMPLATE_VARIABLES.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => insert(v)}
            className="cursor-pointer rounded-md border border-line bg-panel-2 px-2 py-0.5 font-mono text-xs text-ink-2 hover:border-brand hover:text-brand"
          >
            {`{{${v}}}`}
          </button>
        ))}
      </div>
      {value.trim() && (
        <div className="rounded-lg border border-line bg-bg/50 p-3">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Preview</p>
          <p className="whitespace-pre-wrap text-sm text-ink-2">{renderTemplate(value, SAMPLE_VARS)}</p>
        </div>
      )}
    </div>
  )
}

export function StepEditor({
  step,
  isFirst,
  readOnly,
  onChange,
  onDelete,
  onClose,
}: {
  step: SequenceStep
  isFirst: boolean
  readOnly: boolean
  onChange: (patch: Partial<SequenceStep>) => void
  onDelete: () => void
  onClose: () => void
}) {
  const meta = STEP_META[step.kind]
  const setConfig = (patch: Partial<SequenceStep['config']>) => onChange({ config: { ...step.config, ...patch } })
  const clampInt = (v: string, max: number) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)))

  return (
    <aside className="absolute inset-y-0 right-0 z-10 flex w-full max-w-md flex-col border-l border-line bg-sidebar shadow-2xl">
      <header className="flex items-center gap-3 border-b border-line p-5">
        <StepIcon kind={step.kind} />
        <div className="flex-1">
          <h3 className="font-semibold">{meta.label}</h3>
          <p className="text-xs text-ink-3">{meta.description}</p>
        </div>
        <button onClick={onClose} className="cursor-pointer rounded-md p-1 text-ink-2 hover:text-ink" aria-label="Close editor">
          <X size={20} />
        </button>
      </header>

      <fieldset disabled={readOnly} className="flex-1 space-y-6 overflow-y-auto p-5">
        {step.kind !== 'end' && (
          <div className="space-y-2">
            <span className="text-sm font-medium text-ink-2">{isFirst ? 'Wait after the lead enters the campaign' : 'Wait after the previous step'}</span>
            <div className="grid grid-cols-2 gap-3">
              <div className="relative">
                <Input type="number" min={0} max={90} value={step.delay.days} onChange={(e) => onChange({ delay: { ...step.delay, days: clampInt(e.target.value, 90) } })} />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-3">days</span>
              </div>
              <div className="relative">
                <Input type="number" min={0} max={23} value={step.delay.hours} onChange={(e) => onChange({ delay: { ...step.delay, hours: clampInt(e.target.value, 23) } })} />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-3">hours</span>
              </div>
            </div>
            <p className="text-xs text-ink-3">Actions only run inside the campaign’s working hours.</p>
          </div>
        )}

        {step.kind === 'invite' && (
          <MessageField
            label="Personal note (optional)"
            value={step.config.message ?? ''}
            onChange={(message) => setConfig({ message })}
            limit={INVITE_NOTE_LIMIT}
            placeholder="Leave empty to send an invite without a note"
          />
        )}

        {step.kind === 'message' && (
          <MessageField label="Message" value={step.config.message ?? ''} onChange={(message) => setConfig({ message })} rows={8} />
        )}

        {step.kind === 'email' && (
          <>
            <Field label="Subject">
              <Input value={step.config.subject ?? ''} onChange={(e) => setConfig({ subject: e.target.value })} />
            </Field>
            <MessageField label="Body" value={step.config.message ?? ''} onChange={(message) => setConfig({ message })} rows={10} />
          </>
        )}

        {step.kind === 'endorse' && (
          <Field label="Number of skills to endorse">
            <Select value={step.config.skillsCount ?? 3} onChange={(e) => setConfig({ skillsCount: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </Select>
          </Field>
        )}

        {step.kind === 'condition' && (
          <>
            <Field label="Check if the lead…">
              <Select value={step.config.condition} onChange={(e) => setConfig({ condition: e.target.value as ConditionKind })}>
                {(Object.keys(CONDITION_META) as ConditionKind[]).map((k) => (
                  <option key={k} value={k}>{CONDITION_META[k].question}</option>
                ))}
              </Select>
            </Field>
            <Field label="Wait up to (days)" hint="If the condition isn’t met within this time, the lead follows the “No” branch.">
              <Input type="number" min={0} max={60} value={step.config.withinDays ?? 0} onChange={(e) => setConfig({ withinDays: clampInt(e.target.value, 60) })} />
            </Field>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="rounded-lg border border-ok/30 bg-ok/10 p-3 text-ok">Yes → left branch</div>
              <div className="rounded-lg border border-bad/30 bg-bad/10 p-3 text-bad">No → right branch</div>
            </div>
          </>
        )}

        {step.kind === 'message' && (
          <p className="rounded-lg border border-warn/30 bg-warn/10 p-3 text-xs text-warn">
            LinkedIn messages only reach 1st-degree connections. Place this after an “Invite accepted” condition.
          </p>
        )}
      </fieldset>

      {!readOnly && (
        <footer className="border-t border-line p-5">
          <Button variant="ghost" className="text-bad hover:text-bad" onClick={onDelete}>
            <Trash2 size={16} /> {step.kind === 'condition' ? 'Delete condition and its branches' : 'Delete step'}
          </Button>
        </footer>
      )}
    </aside>
  )
}
