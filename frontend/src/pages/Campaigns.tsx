import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Megaphone, Plus, Search } from 'lucide-react'
import { errorMessage } from '../api/client'
import { useCampaigns } from '../api/hooks-campaigns'
import { Button, Card, Checkbox, EmptyState, ErrorState, PageHeader, Skeleton } from '../components/ui'
import { CampaignTable } from '../components/CampaignTable'

export function CampaignListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading campaigns">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="grid gap-6 border-t border-line pt-6 md:grid-cols-2 xl:grid-cols-[1.4fr_1fr_1fr_auto]">
          <div className="space-y-3">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-1.5 w-full" />
          </div>
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
          <Skeleton className="h-8 w-28" />
        </div>
      ))}
    </div>
  )
}

export default function Campaigns() {
  const navigate = useNavigate()
  const campaigns = useCampaigns()
  const [q, setQ] = useState('')
  const [activeOnly, setActiveOnly] = useState(false)

  const all = campaigns.data ?? []
  const term = q.trim().toLowerCase()
  const filtered = all.filter((c) => c.name.toLowerCase().includes(term) && (!activeOnly || c.status === 'active'))
  const newButton = (
    <Button size="lg" onClick={() => navigate('/campaigns/new')}>
      <Plus size={18} /> New campaign
    </Button>
  )

  return (
    <>
      <PageHeader title="Campaigns" actions={all.length > 0 ? newButton : undefined} />
      <Card className="p-5 sm:p-10">
        {campaigns.isPending ? (
          <CampaignListSkeleton />
        ) : campaigns.isError && !campaigns.data ? (
          <ErrorState title="Couldn’t load your campaigns" message={errorMessage(campaigns.error)} onRetry={() => void campaigns.refetch()} />
        ) : !all.length ? (
          <EmptyState
            icon={<Megaphone size={36} />}
            title="No campaigns yet"
            body="Add leads, build your own sequence – invite, message, follow-up – and let it run inside your active hours."
            action={<Button size="lg" onClick={() => navigate('/campaigns/new')}><Plus size={18} /> Create your first campaign</Button>}
          />
        ) : (
          <>
            <div className="mb-8 flex flex-wrap items-center gap-4 sm:gap-6">
              <div className="relative w-full max-w-md">
                <Search size={20} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-2" aria-hidden />
                <input
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search campaigns"
                  aria-label="Search campaigns"
                  className="h-12 w-full rounded-xl border border-line-strong bg-transparent pl-12 pr-4 text-ink placeholder:text-ink-2 focus:border-brand focus:outline-none"
                />
              </div>
              <Checkbox checked={activeOnly} onChange={setActiveOnly} label="Active only" />
              <span className="text-sm text-ink-3 sm:ml-auto" aria-live="polite">
                {filtered.length} of {all.length}
              </span>
            </div>
            {filtered.length ? (
              <CampaignTable campaigns={filtered} />
            ) : (
              <EmptyState
                icon={<Search size={32} />}
                title="No campaigns match your filters"
                action={
                  <Button variant="outline" onClick={() => { setQ(''); setActiveOnly(false) }}>
                    Clear filters
                  </Button>
                }
              />
            )}
          </>
        )}
      </Card>
    </>
  )
}
