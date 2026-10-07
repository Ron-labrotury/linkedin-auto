import { useEffect, type ButtonHTMLAttributes, type ComponentProps, type ReactNode } from 'react'
import { X, Info, CheckCircle2, AlertCircle } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useToasts } from '../../store/useStore'

/* ---------- Button ---------- */

type Variant = 'primary' | 'outline' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors cursor-pointer',
        'disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
        size === 'sm' && 'h-8 px-3 text-sm',
        size === 'md' && 'h-10 px-4 text-sm',
        size === 'lg' && 'h-12 px-6 text-base',
        variant === 'primary' && 'bg-brand text-white hover:bg-brand-strong',
        variant === 'outline' && 'border border-ink-2/60 text-ink hover:bg-panel-2 hover:border-ink-2',
        variant === 'ghost' && 'text-ink-2 hover:bg-panel-2 hover:text-ink',
        variant === 'danger' && 'bg-bad/90 text-white hover:bg-bad',
        className,
      )}
      {...props}
    />
  )
}

/* ---------- Card ---------- */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-2xl bg-panel border border-line/60', className)}>{children}</div>
}

/* ---------- Inputs ---------- */

const fieldBase =
  'w-full rounded-lg border border-line bg-bg/60 px-3 text-sm text-ink placeholder:text-ink-3 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(fieldBase, 'h-10', className)} {...props} />
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(fieldBase, 'py-2.5 leading-relaxed resize-y', className)} {...props} />
}

export function Select({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <select className={cn(fieldBase, 'h-10 pr-8', className)} {...props}>
      {children}
    </select>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="block text-xs text-ink-3">{hint}</span>}
    </label>
  )
}

export function Checkbox({ checked, onChange, label, description }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-5 shrink-0 cursor-pointer appearance-none rounded-md border border-line-strong bg-bg checked:border-brand checked:bg-brand bg-center bg-no-repeat checked:bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 20 20%22 fill=%22white%22><path d=%22M8.3 13.3 4.7 9.7l1.4-1.4 2.2 2.2 5.6-5.6 1.4 1.4z%22/></svg>')]"
      />
      <span>
        <span className="block text-sm text-ink">{label}</span>
        {description && <span className="block text-xs text-ink-3">{description}</span>}
      </span>
    </label>
  )
}

/* ---------- Toggle ---------- */

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors',
        checked ? 'bg-ok' : 'bg-line-strong',
      )}
    >
      <span className={cn('inline-block size-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-5.5' : 'translate-x-0.5')} />
    </button>
  )
}

/* ---------- Progress ring (single-series meter) ---------- */

export function ProgressRing({ value, size = 76, stroke = 6 }: { value: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const v = Math.max(0, Math.min(100, value))
  return (
    <div className="relative" style={{ width: size, height: size }} role="img" aria-label={`${v}%`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-line)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--color-brand)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c - (v / 100) * c}
          className="transition-[stroke-dashoffset] duration-700"
        />
      </svg>
      <span className="absolute inset-0 grid place-items-center text-sm font-semibold text-ink">{v} %</span>
    </div>
  )
}

/* ---------- Modal ---------- */

export function Modal({
  open,
  onClose,
  children,
  className,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  className?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-bg/60 backdrop-blur-sm" onClick={onClose} />
      <div role="dialog" aria-modal className={cn('relative w-full max-w-2xl rounded-2xl border border-line bg-sidebar p-8 shadow-2xl', className)}>
        <button onClick={onClose} aria-label="Close" className="absolute right-5 top-5 rounded-md p-1 text-ink-2 hover:bg-panel-2 hover:text-ink cursor-pointer">
          <X size={20} />
        </button>
        {children}
      </div>
    </div>
  )
}

export function ConfirmModal({
  open,
  title,
  body,
  confirmLabel = 'Delete',
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  body: ReactNode
  confirmLabel?: string
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal open={open} onClose={onClose} className="max-w-md">
      <h3 className="text-lg font-semibold">{title}</h3>
      <div className="mt-2 text-sm text-ink-2">{body}</div>
      <div className="mt-6 flex justify-end gap-3">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button variant="danger" onClick={() => { onConfirm(); onClose() }}>{confirmLabel}</Button>
      </div>
    </Modal>
  )
}

/* ---------- Misc ---------- */

export function Avatar({ name, size = 36, className }: { name: string; size?: number; className?: string }) {
  const initials = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase()
  const hue = [...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 360
  return (
    <span
      className={cn('inline-grid shrink-0 place-items-center rounded-full font-semibold text-white', className)}
      style={{ width: size, height: size, fontSize: size * 0.38, background: `oklch(0.55 0.12 ${hue})` }}
    >
      {initials}
    </span>
  )
}

const badgeTones = {
  neutral: 'bg-line/60 text-ink-2',
  brand: 'bg-brand-soft text-brand',
  ok: 'bg-ok/15 text-ok',
  warn: 'bg-warn/15 text-warn',
  bad: 'bg-bad/15 text-bad',
  info: 'bg-info/15 text-info',
}

export function Badge({ tone = 'neutral', children }: { tone?: keyof typeof badgeTones; children: ReactNode }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium', badgeTones[tone])}>{children}</span>
}

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-5 grid size-20 place-items-center rounded-2xl bg-panel-2 text-brand">{icon}</div>
      <h3 className="text-xl font-medium">{title}</h3>
      {body && <p className="mt-2 max-w-md text-sm text-ink-2">{body}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  )
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="flex border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            'relative flex-1 cursor-pointer px-6 py-5 text-left text-[15px] font-medium transition-colors',
            value === t.id ? 'text-ink' : 'text-ink-2 hover:text-ink',
          )}
        >
          {t.label}
          {value === t.id && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-brand" />}
        </button>
      ))}
    </div>
  )
}

export function Toaster() {
  const { toasts, dismiss } = useToasts()
  return (
    <div className="fixed right-6 top-6 z-[60] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-3">
      {toasts.map((t) => (
        <div key={t.id} className="flex items-center gap-4 rounded-2xl border border-line bg-sidebar p-5 shadow-2xl">
          <span
            className={cn(
              'grid size-11 shrink-0 place-items-center rounded-full',
              t.tone === 'success' ? 'bg-ok/15 text-ok' : t.tone === 'error' ? 'bg-bad/15 text-bad' : 'bg-info/15 text-info',
            )}
          >
            {t.tone === 'success' ? <CheckCircle2 size={22} /> : t.tone === 'error' ? <AlertCircle size={22} /> : <Info size={22} />}
          </span>
          <p className="flex-1 text-[15px] font-medium">{t.message}</p>
          <button onClick={() => dismiss(t.id)} className="cursor-pointer text-ink-3 hover:text-ink" aria-label="Dismiss">
            <X size={18} />
          </button>
        </div>
      ))}
    </div>
  )
}

export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      {actions}
    </div>
  )
}
