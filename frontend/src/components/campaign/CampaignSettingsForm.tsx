import type { ReactNode } from 'react'
import type { CampaignSettings } from '../../types'
import { cn } from '../../lib/utils'
import { Checkbox, Field, Input, Select } from '../ui'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Australia/Sydney', 'UTC']

/** LinkedIn's practical safe limits. The backend should enforce these too. */
const LIMITS = {
  dailyInvites: { max: 100, safe: 30, label: 'Connection invites / day' },
  dailyMessages: { max: 150, safe: 50, label: 'Messages / day' },
  dailyProfileViews: { max: 150, safe: 60, label: 'Profile views / day' },
  dailyEmails: { max: 300, safe: 100, label: 'Emails / day' },
} as const

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="grid gap-6 border-t border-line py-8 first:border-0 first:pt-0 lg:grid-cols-[280px_1fr]">
      <div>
        <h3 className="font-semibold">{title}</h3>
        {description && <p className="mt-1 text-sm text-ink-3">{description}</p>}
      </div>
      <div className="space-y-5">{children}</div>
    </section>
  )
}

export function CampaignSettingsForm({
  name,
  onNameChange,
  settings,
  onChange,
}: {
  name: string
  onNameChange: (v: string) => void
  settings: CampaignSettings
  onChange: (s: CampaignSettings) => void
}) {
  const set = <K extends keyof CampaignSettings>(k: K, v: CampaignSettings[K]) => onChange({ ...settings, [k]: v })
  const hours = Array.from({ length: 24 }, (_, h) => h)
  const fmtHour = (h: number) => `${((h + 11) % 12) + 1}:00 ${h < 12 ? 'am' : 'pm'}`

  return (
    <div>
      <Section title="Campaign name">
        <Input value={name} onChange={(e) => onNameChange(e.target.value)} placeholder="e.g. Pune manufacturing heads" maxLength={80} />
      </Section>

      <Section title="Daily limits" description="Spread actions out to keep your LinkedIn account safe. Values above the recommended limit are risky.">
        <div className="grid gap-5 sm:grid-cols-2">
          {(Object.keys(LIMITS) as (keyof typeof LIMITS)[]).map((k) => {
            const meta = LIMITS[k]
            const v = settings[k]
            const risky = v > meta.safe
            return (
              <Field key={k} label={meta.label} hint={<span className={cn(risky && 'text-warn')}>{risky ? `Above the recommended ${meta.safe}` : `Recommended: up to ${meta.safe}`}</span>}>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={0}
                    max={meta.max}
                    value={v}
                    onChange={(e) => set(k, Number(e.target.value))}
                    className="flex-1 accent-[var(--color-brand)]"
                    aria-label={meta.label}
                  />
                  <Input
                    type="number"
                    min={0}
                    max={meta.max}
                    value={v}
                    onChange={(e) => set(k, Math.max(0, Math.min(meta.max, Number(e.target.value) || 0)))}
                    className="w-20 text-center"
                  />
                </div>
              </Field>
            )
          })}
        </div>
      </Section>

      <Section title="Schedule" description="Actions only run during these hours, in the lead-facing time zone you choose.">
        <div>
          <span className="mb-2 block text-sm font-medium text-ink-2">Working days</span>
          <div className="flex flex-wrap gap-2">
            {DAYS.map((d, i) => {
              const on = settings.workingDays.includes(i)
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set('workingDays', on ? settings.workingDays.filter((x) => x !== i) : [...settings.workingDays, i].sort())}
                  className={cn(
                    'h-10 w-14 cursor-pointer rounded-lg border text-sm font-medium transition-colors',
                    on ? 'border-brand bg-brand-soft text-brand' : 'border-line text-ink-2 hover:border-line-strong',
                  )}
                >
                  {d}
                </button>
              )
            })}
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="From">
            <Select value={settings.startHour} onChange={(e) => set('startHour', Number(e.target.value))}>
              {hours.map((h) => <option key={h} value={h} disabled={h >= settings.endHour}>{fmtHour(h)}</option>)}
            </Select>
          </Field>
          <Field label="To">
            <Select value={settings.endHour} onChange={(e) => set('endHour', Number(e.target.value))}>
              {hours.map((h) => <option key={h} value={h} disabled={h <= settings.startHour}>{fmtHour(h)}</option>)}
            </Select>
          </Field>
          <Field label="Time zone">
            <Select value={settings.timezone} onChange={(e) => set('timezone', e.target.value)}>
              {TIMEZONES.map((t) => <option key={t}>{t}</option>)}
            </Select>
          </Field>
        </div>
      </Section>

      <Section title="Safety & targeting">
        <Checkbox checked={settings.skipConnected} onChange={(v) => set('skipConnected', v)} label="Skip leads who are already 1st-degree connections" description="They won’t receive an invite step; message steps still run." />
        <Checkbox checked={settings.skipOtherCampaigns} onChange={(v) => set('skipOtherCampaigns', v)} label="Skip leads that are in another active campaign" />
        <Checkbox checked={settings.stopOnReply} onChange={(v) => set('stopOnReply', v)} label="Stop the sequence when a lead replies" description="On LinkedIn or by email." />
      </Section>
    </div>
  )
}
