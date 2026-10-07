import { useState } from 'react'
import { Mail, RotateCcw, ShieldCheck } from 'lucide-react'
import { LinkedInIcon as Linkedin } from '../components/ui/LinkedInIcon'
import type { LinkedInAccount } from '../types'
import { useStore, toast } from '../store/useStore'
import { Avatar, Badge, Button, Card, ConfirmModal, Field, Input, PageHeader, Select } from '../components/ui'

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card className="grid gap-6 p-6 sm:p-8 lg:grid-cols-[280px_1fr]">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="mt-1 text-sm text-ink-3">{description}</p>}
      </div>
      <div className="space-y-5">{children}</div>
    </Card>
  )
}

export default function Settings() {
  const { account, updateAccount, resetDemo } = useStore()
  const [name, setName] = useState(account.name)
  const [headline, setHeadline] = useState(account.headline)
  const [smtpHost, setSmtpHost] = useState('')
  const [smtpUser, setSmtpUser] = useState('')
  const [reset, setReset] = useState(false)

  return (
    <>
      <PageHeader title="Settings" />
      <div className="space-y-6">
        <Section title="LinkedIn account" description="Campaigns send actions from this account. Connection happens through the backend; your password is never stored in the browser.">
          <div className="flex flex-wrap items-center gap-4 rounded-xl border border-line p-4">
            <Avatar name={account.name} size={48} />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{account.name}</p>
              <p className="truncate text-sm text-ink-3">{account.headline}</p>
            </div>
            <Badge tone={account.connected ? 'ok' : 'bad'}>
              <Linkedin size={12} /> {account.connected ? 'Connected' : 'Disconnected'}
            </Badge>
            <Button
              variant={account.connected ? 'outline' : 'primary'}
              onClick={() => {
                updateAccount({ connected: !account.connected })
                toast(account.connected ? 'LinkedIn account disconnected' : 'LinkedIn account connected', 'success')
              }}
            >
              {account.connected ? 'Disconnect' : 'Connect LinkedIn'}
            </Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Display name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="LinkedIn plan">
              <Select value={account.plan} onChange={(e) => updateAccount({ plan: e.target.value as LinkedInAccount['plan'] })}>
                <option>Free</option>
                <option>Premium</option>
                <option>Sales Navigator</option>
              </Select>
            </Field>
          </div>
          <Field label="Headline"><Input value={headline} onChange={(e) => setHeadline(e.target.value)} /></Field>
          <div className="flex justify-end">
            <Button
              disabled={!name.trim() || (name === account.name && headline === account.headline)}
              onClick={() => {
                updateAccount({ name: name.trim(), headline: headline.trim() })
                toast('Profile saved', 'success')
              }}
            >
              Save profile
            </Button>
          </div>
        </Section>

        <Section title="Email account" description="Used by “Send email” steps. Gmail and Outlook OAuth will be added with the backend.">
          <div className="grid gap-3 sm:grid-cols-2">
            <Button variant="outline" disabled><Mail size={16} /> Connect Gmail</Button>
            <Button variant="outline" disabled><Mail size={16} /> Connect Outlook</Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="SMTP host"><Input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.example.com" /></Field>
            <Field label="SMTP username"><Input value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} placeholder="you@example.com" /></Field>
          </div>
          <div className="flex justify-end">
            <Button disabled={!smtpHost || !smtpUser} onClick={() => toast('SMTP details will be verified once the backend is connected')}>Save mailbox</Button>
          </div>
        </Section>

        <Section title="Account safety" description="Global limits that apply on top of each campaign’s own limits.">
          <div className="flex items-start gap-3 rounded-xl border border-ok/30 bg-ok/10 p-4 text-sm">
            <ShieldCheck size={20} className="shrink-0 text-ok" />
            <p className="text-ink-2">
              Actions are spread randomly inside working hours with human-like pauses. Weekly invite cap: <span className="font-semibold text-ink">{account.plan === 'Free' ? 100 : 200}</span> (based on your {account.plan} plan).
            </p>
          </div>
        </Section>

        <Section title="Demo data" description="This frontend runs on sample data stored in your browser.">
          <div>
            <Button variant="outline" onClick={() => setReset(true)}><RotateCcw size={16} /> Reset demo data</Button>
          </div>
        </Section>
      </div>

      <ConfirmModal
        open={reset}
        onClose={() => setReset(false)}
        title="Reset demo data?"
        body="All campaigns, leads and messages you created in this browser will be replaced with the sample data."
        confirmLabel="Reset"
        onConfirm={() => {
          resetDemo()
          setName(useStore.getState().account.name)
          setHeadline(useStore.getState().account.headline)
          toast('Demo data reset', 'success')
        }}
      />
    </>
  )
}
