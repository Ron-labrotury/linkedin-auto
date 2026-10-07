import { useState } from 'react'
import { UserPlus, Trash2 } from 'lucide-react'
import { LinkedInIcon as Linkedin } from '../components/ui/LinkedInIcon'
import type { TeamMember } from '../types'
import { useStore, toast } from '../store/useStore'
import { formatDate } from '../lib/utils'
import { Avatar, Badge, Button, Card, ConfirmModal, Field, Input, Modal, PageHeader, Select } from '../components/ui'

export default function Teams() {
  const { team, inviteMember, removeMember } = useStore()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<TeamMember['role']>('Member')
  const [removing, setRemoving] = useState<TeamMember | null>(null)
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  const duplicate = team.some((m) => m.email.toLowerCase() === email.toLowerCase())

  return (
    <>
      <PageHeader title="Teams" actions={<Button size="lg" onClick={() => setOpen(true)}><UserPlus size={18} /> Invite member</Button>} />
      <Card className="p-6 sm:p-8">
        <p className="mb-6 text-sm text-ink-2">Each member connects their own LinkedIn account and runs their own campaigns. Admins can view and manage everyone’s campaigns.</p>
        <ul className="divide-y divide-line">
          {team.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-4 py-5">
              <Avatar name={m.name} size={44} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{m.name}</p>
                <p className="text-sm text-ink-3">{m.email}</p>
              </div>
              <span className="flex items-center gap-1.5 text-sm text-ink-2">
                <Linkedin size={16} className={m.linkedinConnected ? 'text-info' : 'text-ink-3'} />
                {m.linkedinConnected ? 'Connected' : 'Not connected'}
              </span>
              <span className="w-32 text-sm text-ink-2">{m.activeCampaigns} active campaign{m.activeCampaigns === 1 ? '' : 's'}</span>
              <span className="w-28 text-sm text-ink-3">Since {formatDate(m.invitedAt)}</span>
              <Badge tone={m.role === 'Owner' ? 'brand' : m.role === 'Admin' ? 'info' : 'neutral'}>{m.role}</Badge>
              <button
                disabled={m.role === 'Owner'}
                onClick={() => setRemoving(m)}
                className="cursor-pointer p-1 text-ink-3 hover:text-bad disabled:invisible"
                aria-label={`Remove ${m.name}`}
              >
                <Trash2 size={18} />
              </button>
            </li>
          ))}
        </ul>
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} className="max-w-lg">
        <h3 className="text-xl font-semibold">Invite a team member</h3>
        <div className="mt-6 space-y-4">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
          <Field label="Email" hint={duplicate ? <span className="text-bad">Already on the team</span> : undefined}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value as TeamMember['role'])}>
              <option>Member</option>
              <option>Admin</option>
            </Select>
          </Field>
        </div>
        <div className="mt-8 flex justify-end gap-3">
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            disabled={!name.trim() || !emailValid || duplicate}
            onClick={() => {
              inviteMember(name.trim(), email.trim(), role)
              toast(`Invitation sent to ${email}`, 'success')
              setName(''); setEmail(''); setRole('Member'); setOpen(false)
            }}
          >
            Send invite
          </Button>
        </div>
      </Modal>

      <ConfirmModal
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.name}?`}
        body="Their campaigns will be paused."
        confirmLabel="Remove"
        onConfirm={() => removing && removeMember(removing.id)}
      />
    </>
  )
}
