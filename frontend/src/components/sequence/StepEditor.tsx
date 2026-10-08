import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { X, Trash2, Shuffle, AlertTriangle, Info } from 'lucide-react'
import type { ConditionKind, Delay, DelayUnit, Duration, SequenceStep } from '@shared/types.ts'
import { DEFAULT_CONDITION_WITHIN, INVITE_NOTE_LIMIT, MESSAGE_LIMIT, TEMPLATE_VARIABLES, formatDuration, renderTemplate } from '@shared/sequence.ts'
import {
  CONDITION_META,
  CONDITION_ORDER,
  DELAY_UNITS,
  SAMPLE_VARS,
  STEP_META,
  delayError,
  inviteNoteOverflow,
  stepTitle,
  unknownVariables,
  withinError,
} from '../../lib/sequence'
import { cn } from '../../lib/utils'
import { Button, Select, Textarea } from '../ui'
import { StepIcon } from './stepVisuals'

/** Whole-number input that lets the field be empty while typing. */
function NumberInput({ value, onChange, label, max, invalid }: { value: number; onChange: (n: number) => void; label: string; max: number; invalid?: boolean }) {
  const [text, setText] = useState(String(value))
  useEffect(() => {
    setText((t) => (Number(t) === value && t.trim() !== '' ? t : String(value)))
  }, [value])
  return (
    <input
      type="number"
      inputMode="numeric"
      min={0}
      max={max}
      step={1}
      aria-label={label}
      aria-invalid={invalid || undefined}
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        const n = Number(e.target.value)
        if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= 0) onChange(Math.floor(n))
      }}
      onBlur={() => setText(String(value))}
      className="h-10 w-20 rounded-lg border border-line bg-bg/60 px-3 text-center text-sm tabular-nums text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25 aria-[invalid=true]:border-bad/70"
    />
  )
}

function UnitSelect({ value, onChange, label }: { value: DelayUnit; onChange: (u: DelayUnit) => void; label: string }) {
  return (
    <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as DelayUnit)} className="w-auto min-w-28">
      {DELAY_UNITS.map((u) => (
        <option key={u.id} value={u.id}>{u.label}</option>
      ))}
    </Select>
  )
}

function FieldError({ children }: { children: string | null }) {
  if (!children) return null
  return (
    <p role="alert" className="flex items-start gap-1.5 text-xs font-medium text-bad">
      <AlertTriangle size={14} className="mt-px shrink-0" aria-hidden /> {children}
    </p>
  )
}

function DelayEditor({ delay, onChange, isFirst }: { delay: Delay; onChange: (d: Delay) => void; isFirst: boolean }) {
  const error = delayError(delay)
  const headingId = useId()
  return (
    <section className="space-y-3" aria-labelledby={headingId}>
      <h4 id={headingId} className="text-sm font-medium text-ink-2">
        {isFirst ? 'Wait after the lead is added to the campaign' : 'Wait after the previous step'}
      </h4>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>Wait a random time between</span>
        <NumberInput label="Minimum wait" value={delay.min} max={9999} invalid={!!error} onChange={(min) => onChange({ ...delay, min })} />
        <span>and</span>
        <NumberInput label="Maximum wait" value={delay.max} max={9999} invalid={!!error} onChange={(max) => onChange({ ...delay, max })} />
        <UnitSelect label="Wait unit" value={delay.unit} onChange={(unit) => onChange({ ...delay, unit })} />
      </div>
      <FieldError>{error}</FieldError>
      <p className="flex items-start gap-2 rounded-lg border border-line bg-bg/40 p-3 text-xs leading-relaxed text-ink-2">
        <Shuffle size={14} className="mt-0.5 shrink-0 text-brand" aria-hidden />
        <span>
          The exact wait is picked randomly for every lead, so your outreach doesn’t follow a robotic rhythm. Set both to 0 to run right away.
          Steps only run inside your <Link to="/settings" className="text-brand hover:underline">active hours</Link>, with a random pause between any two LinkedIn actions.
        </span>
      </p>
    </section>
  )
}

function ConditionEditor({
  step,
  setConfig,
  stopOnReply,
  yesBranchHasSteps,
}: {
  step: SequenceStep
  setConfig: (p: Partial<SequenceStep['config']>) => void
  stopOnReply: boolean
  yesBranchHasSteps: boolean
}) {
  const kind = step.config.condition ?? 'accepted_invite'
  const meta = CONDITION_META[kind] ?? CONDITION_META.accepted_invite
  const within: Duration = step.config.within ?? DEFAULT_CONDITION_WITHIN
  const error = withinError(step.config.within)
  // With "Stop the sequence when a lead replies" on, a detected reply finishes the lead right here.
  const replyEnds = kind === 'replied' && stopOnReply
  return (
    <div className="space-y-6">
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-ink-2">Check if the lead…</span>
        <Select value={kind} onChange={(e) => setConfig({ condition: e.target.value as ConditionKind })}>
          {CONDITION_ORDER.map((k) => (
            <option key={k} value={k}>{CONDITION_META[k].question}</option>
          ))}
        </Select>
      </label>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>Keep checking for up to</span>
          <NumberInput label="Waiting time" value={within.value} max={9999} invalid={!!error} onChange={(value) => setConfig({ within: { ...within, value } })} />
          <UnitSelect label="Waiting time unit" value={within.unit} onChange={(unit) => setConfig({ within: { ...within, unit } })} />
        </div>
        <FieldError>{error}</FieldError>
      </div>
      <div className="grid gap-3 text-xs leading-relaxed sm:grid-cols-2">
        <div className="rounded-lg border border-ok/30 bg-ok/10 p-3">
          <p className="font-semibold text-ok">Yes – left branch</p>
          <p className="mt-1 text-ink-2">
            {replyEnds ? 'The lead’s sequence ends as soon as they reply – “Stop the sequence when a lead replies” is on.' : `The lead moves on ${meta.yes}.`}
          </p>
        </div>
        <div className="rounded-lg border border-bad/30 bg-bad/10 p-3">
          <p className="font-semibold text-bad">No – right branch</p>
          <p className="mt-1 text-ink-2">The lead moves on {meta.no} after {formatDuration(within)}.</p>
        </div>
      </div>
      {kind === 'accepted_invite' && <Tip>Put a “Send invite” step before this condition. A typical flow sends a message on Yes and withdraws the invite on No.</Tip>}
      {kind === 'replied' && replyEnds && yesBranchHasSteps && (
        <Tip tone="warn">
          The steps on the Yes branch won’t run: “Stop the sequence when a lead replies” is on in the campaign settings, so a reply ends the sequence
          for that lead. Turn that setting off if they should run.
        </Tip>
      )}
      {kind === 'replied' && <Tip>Put this after a “Send message” step and add a follow-up message on the No branch.</Tip>}
    </div>
  )
}

function Tip({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  return (
    <p className={cn('flex items-start gap-2 rounded-lg border p-3 text-xs leading-relaxed', tone === 'warn' ? 'border-warn/30 bg-warn/10 text-warn' : 'border-info/30 bg-info/10 text-ink-2')}>
      {tone === 'warn' ? <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden /> : <Info size={14} className="mt-0.5 shrink-0 text-info" aria-hidden />}
      <span>{children}</span>
    </p>
  )
}

function MessageField({
  label,
  value,
  onChange,
  limit,
  required,
  rows = 6,
  placeholder,
  warning,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  limit: number
  required?: boolean
  rows?: number
  placeholder?: string
  /** Shown below the field when the text is allowed but risky. */
  warning?: ReactNode
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const id = useId()
  const insert = (v: string) => {
    const el = ref.current
    const token = `{{${v}}}`
    if (!el) return onChange(value + token)
    const start = el.selectionStart ?? value.length
    const end = el.selectionEnd ?? value.length
    onChange(value.slice(0, start) + token + value.slice(end))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + token.length, start + token.length)
    })
  }
  const over = value.length > limit
  const empty = required && !value.trim()
  const unknown = unknownVariables(value, TEMPLATE_VARIABLES)
  const preview = renderTemplate(value, SAMPLE_VARS)

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-ink-2">{label}</label>
        <span className={cn('text-xs tabular-nums', over ? 'font-semibold text-bad' : 'text-ink-3')} aria-live="polite">
          {value.length.toLocaleString('en-US')}/{limit.toLocaleString('en-US')}
        </span>
      </div>
      <Textarea
        id={id}
        ref={ref}
        rows={rows}
        value={value}
        placeholder={placeholder}
        aria-invalid={over || empty || undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      <FieldError>{over ? `Too long – keep it under ${limit.toLocaleString('en-US')} characters` : empty ? 'Write the message that will be sent' : null}</FieldError>
      {warning && <Tip tone="warn">{warning}</Tip>}
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Insert a variable">
        <span className="mr-1 text-xs text-ink-3">Insert:</span>
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
      {unknown.length > 0 && (
        <Tip tone="warn">
          Unknown variable{unknown.length > 1 ? 's' : ''} {unknown.map((u) => `{{${u}}}`).join(', ')}. Use the buttons above – only those are filled in.
        </Tip>
      )}
      {value.trim() && (
        <div className="rounded-lg border border-line bg-bg/50 p-3">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Preview for {SAMPLE_VARS.first_name} {SAMPLE_VARS.last_name}</p>
          <p className="whitespace-pre-wrap break-words text-sm text-ink-2">{preview}</p>
          <p className="mt-2 text-[11px] text-ink-3">Variables a lead doesn’t have (e.g. no company) are left out.</p>
        </div>
      )}
    </div>
  )
}

export function StepEditor({
  step,
  index,
  isFirst,
  readOnly,
  onChange,
  onDelete,
  onClose,
  stopOnReply = false,
  yesBranchHasSteps = false,
}: {
  step: SequenceStep
  index: number
  isFirst: boolean
  readOnly: boolean
  onChange: (patch: Partial<SequenceStep>) => void
  onDelete: () => void
  onClose: () => void
  /** The campaign's "Stop the sequence when a lead replies" setting. */
  stopOnReply?: boolean
  /** A condition whose Yes branch holds steps (not just End). */
  yesBranchHasSteps?: boolean
}) {
  const meta = STEP_META[step.kind] ?? STEP_META.condition
  const isCond = step.kind === 'condition'
  const noteOverflow = step.kind === 'invite' ? inviteNoteOverflow(step.config.message ?? '') : null
  const setConfig = (patch: Partial<SequenceStep['config']>) => onChange({ config: { ...step.config, ...patch } })
  const titleId = useId()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('[role=dialog][aria-modal=true]') && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside aria-labelledby={titleId} className="absolute inset-y-0 right-0 z-10 flex w-full max-w-md flex-col border-l border-line bg-sidebar shadow-2xl">
      <header className="flex items-center gap-3 border-b border-line p-5">
        <StepIcon kind={step.kind} condition={step.config.condition} />
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="font-semibold">
            <span className="text-ink-3">Step {index} · </span>
            {stepTitle(step)}
          </h3>
          <p className="text-xs text-ink-3">{isCond ? CONDITION_META[step.config.condition ?? 'accepted_invite']?.description : meta.description}</p>
        </div>
        <button type="button" onClick={onClose} className="cursor-pointer rounded-md p-1 text-ink-2 hover:text-ink" aria-label="Close step editor">
          <X size={20} />
        </button>
      </header>

      <fieldset disabled={readOnly} className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
        {readOnly && <Tip>This sequence is read-only right now.</Tip>}

        {!isCond && step.kind !== 'end' && <DelayEditor delay={step.delay} isFirst={isFirst} onChange={(delay) => onChange({ delay })} />}

        {step.kind === 'invite' && (
          <>
            <MessageField
              label="Personal note (optional)"
              value={step.config.message ?? ''}
              onChange={(message) => setConfig({ message })}
              limit={INVITE_NOTE_LIMIT}
              rows={5}
              placeholder="Leave empty to send the invite without a note. e.g. Hi {{first_name}}, I'd love to connect."
              warning={
                noteOverflow !== null && (
                  <>
                    Filled in with typical names, companies and titles this note comes to about {noteOverflow} characters. LinkedIn allows{' '}
                    {INVITE_NOTE_LIMIT}, so for leads with longer details the note is shortened to {INVITE_NOTE_LIMIT} characters when it’s sent and the end
                    is cut off. Keep it shorter to be safe.
                  </>
                )
              }
            />
            <Tip>Free LinkedIn accounts can add only a few notes per month; if LinkedIn refuses the note, the invite is sent without it.</Tip>
          </>
        )}

        {step.kind === 'message' && (
          <>
            <MessageField
              label="Message"
              value={step.config.message ?? ''}
              onChange={(message) => setConfig({ message })}
              limit={MESSAGE_LIMIT}
              required
              rows={8}
              placeholder="Hi {{first_name}}, thanks for connecting!"
            />
            <Tip tone="warn">
              LinkedIn messages only reach 1st-degree connections. Put this step on the Yes branch of “If invite accepted” – for anyone else it is skipped.
            </Tip>
          </>
        )}

        {isCond && <ConditionEditor step={step} setConfig={setConfig} stopOnReply={stopOnReply} yesBranchHasSteps={yesBranchHasSteps} />}

        {step.kind === 'withdraw' && <Tip>Usually placed on the No branch of “If invite accepted” to clean up invites that were never accepted.</Tip>}
        {step.kind === 'end' && <Tip>The lead is marked as finished here. Steps after an End are not allowed.</Tip>}
      </fieldset>

      {!readOnly && (
        <footer className="border-t border-line p-5">
          <Button variant="ghost" className="text-bad hover:text-bad" onClick={onDelete}>
            <Trash2 size={16} /> {isCond ? 'Delete condition and its branches' : 'Delete step'}
          </Button>
        </footer>
      )}
    </aside>
  )
}
