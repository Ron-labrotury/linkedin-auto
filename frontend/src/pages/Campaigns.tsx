import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Megaphone, Search } from 'lucide-react'
import { useStore } from '../store/useStore'
import { Button, Card, Checkbox, EmptyState, PageHeader } from '../components/ui'
import { CampaignTable } from '../components/CampaignTable'

export default function Campaigns() {
  const navigate = useNavigate()
  const campaigns = useStore((s) => s.campaigns)
  const [q, setQ] = useState('')
  const [activeOnly, setActiveOnly] = useState(false)

  const filtered = campaigns.filter(
    (c) => c.name.toLowerCase().includes(q.trim().toLowerCase()) && (!activeOnly || c.status === 'active'),
  )

  return (
    <>
      <PageHeader title="Campaigns" />
      <Card className="p-6 sm:p-10">
        <div className="mb-10 flex flex-wrap items-center gap-6">
          <div className="relative w-full max-w-md">
            <Search size={20} className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-2" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search"
              className="h-14 w-full rounded-xl border border-line-strong bg-transparent pl-12 pr-4 text-ink placeholder:text-ink-2 focus:border-brand focus:outline-none"
            />
          </div>
          <Checkbox checked={activeOnly} onChange={setActiveOnly} label="Active only" />
          <Button size="lg" className="ml-auto" onClick={() => navigate('/campaigns/new')}>New campaign</Button>
        </div>
        {filtered.length ? (
          <CampaignTable campaigns={filtered} />
        ) : (
          <EmptyState
            icon={<Megaphone size={36} />}
            title={campaigns.length ? 'No campaigns match your filters' : 'No campaigns yet'}
            action={!campaigns.length && <Button size="lg" onClick={() => navigate('/campaigns/new')}>Create campaign</Button>}
          />
        )}
      </Card>
    </>
  )
}
