import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Clock, ShieldCheck } from 'lucide-react'
import type { CampaignSettings } from '@shared/types.ts'
import { cn } from '../../lib/utils'
import { Field, Input, Toggle } from '../ui'
import { LIMITS, NAME_MAX, settingsErrors, type LimitKey } from './settings'

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-5 border-t border-line py-8 first:border-0 first:pt-0 lg:grid-cols-[260px_1fr] lg:gap-8">
      <div>
        <h3 className="font-semibold">{title}</h3>
        {description && <p className="mt-1 text-sm text-ink-3">{description}</p>}
      </div>
      <div className="min-w-0 space-y-5">{children}</div>
    </section>
  )
}

function ToggleRow({ checked, onChange, label, description }: { checked: boolean; onChange: (v: boolean) => void; label: string; description: string }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-line p-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{label}</p>
        <p className="mt-0.5 text-xs text-ink-3">{description}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} label={label} />
    </div>
  )
}

export function CampaignSettingsForm({
  name,
  onNameChange,
  settings,
  onChange,
  errors = {},
}: {
  name: string
  onNameChange: (v: string) => void
  settings: CampaignSettings
  onChange: (s: CampaignSettings) => void
  /** Extra field errors, e.g. from the server's `details`. */
  errors?: Record<string, string>
}) {
  const set = <K extends keyof CampaignSettings>(k: K, v: CampaignSettings[K]) => onChange({ ...settings, [k]: v })
  const local = settingsErrors(name, settings)
  const err = (k: string) => local[k] ?? errors[k]

  return (
    <div>
      <Section title="Campaign name">
        <Field label="Name" error={err('name')}>
          <Input value={name} onChange={(e) => onNameChange(e.target.value)} placeholder="e.g. Pune manufacturing heads" maxLength={NAME_MAX} aria-invalid={!!err('name')} />
        </Field>
      </Section>

      <Section
        title="Daily limits"
        description="The most actions this campaign does per day. Staying under the recommended values keeps your LinkedIn account safe."
      >
        <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
          {(Object.keys(LIMITS) as LimitKey[]).map((k) => {
            const meta = LIMITS[k]
            const v = settings[k]
            const risky = v > meta.safe
            return (
              <Field
                key={k}
                label={meta.label}
                error={err(`settings.${k}`)}
                hint={<span className={cn(risky && 'font-medium text-warn')}>{risky ? `Above the recommended ${meta.safe} – risky` : `Recommended: up to ${meta.safe}`}</span>}
              >
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={0}
                    max={meta.max}
                    value={Math.min(v, meta.max)}
                    onChange={(e) => set(k, Number(e.target.value))}
                    className="min-w-0 flex-1 accent-[var(--color-brand)]"
                    aria-label={`${meta.label} (slider)`}
                  />
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={meta.max}
                    value={v}
                    onChange={(e) => {
                      const n = Math.floor(Number(e.target.value))
                      set(k, Number.isFinite(n) ? Math.max(0, Math.min(meta.max, n)) : 0)
                    }}
                    className="w-20 text-center tabular-nums"
                    aria-label={meta.label}
                    aria-invalid={!!err(`settings.${k}`)}
                  />
                </div>
              </Field>
            )
          })}
        </div>
        <p className="flex items-start gap-2 text-xs text-ink-3">
          <ShieldCheck size={14} className="mt-px shrink-0 text-ok" aria-hidden />
          Across all campaigns your account never goes above 100 invites, 150 messages and 250 profile views a day.
        </p>
      </Section>

      <Section title="Schedule">
        <p className="flex items-start gap-3 rounded-xl border border-info/30 bg-info/10 p-4 text-sm text-ink-2">
          <Clock size={18} className="mt-px shrink-0 text-info" aria-hidden />
          <span>
            Active hours and the random pause between actions are set in{' '}
            <Link to="/settings#active-hours" className="font-medium text-brand hover:underline">Settings → Active hours</Link>. They apply to all your campaigns.
          </span>
        </p>
      </Section>

      <Section title="Safety & targeting">
        <ToggleRow
          checked={settings.skipConnected}
          onChange={(v) => set('skipConnected', v)}
          label="Skip leads who are already your connections"
          description="When the invite step finds an existing connection, that lead leaves the campaign. Turn off to keep sending them the next steps (e.g. messages)."
        />
        <ToggleRow
          checked={settings.skipOtherCampaigns}
          onChange={(v) => set('skipOtherCampaigns', v)}
          label="Skip leads who are in your other campaigns"
          description="A person who is still in another of your campaigns (running, paused or draft) is added as “Skipped”. A lead is also skipped before its first action if another running or paused campaign has already contacted them."
        />
        <ToggleRow
          checked={settings.stopOnReply}
          onChange={(v) => set('stopOnReply', v)}
          label="Stop the sequence when a lead replies"
          description="Once a lead replies to your campaign on LinkedIn, their sequence ends: no more steps run for them – including the Yes branch of an “If replied” condition."
        />
      </Section>
    </div>
  )
}
