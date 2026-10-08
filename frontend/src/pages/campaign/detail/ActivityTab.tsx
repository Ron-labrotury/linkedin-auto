import { Activity as ActivityIcon } from 'lucide-react'
import type { Campaign } from '@shared/types.ts'
import { errorMessage } from '../../../api/client'
import { useActivity } from '../../../api/hooks-campaigns'
import { EmptyState, ErrorState, Skeleton } from '../../../components/ui'
import { ActivityList } from '../../../components/campaign/ActivityFeed'

export function ActivityTab({ campaign }: { campaign: Campaign }) {
  const activity = useActivity(campaign.id)

  if (activity.isPending)
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading activity">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
    )
  if (activity.isError && !activity.data)
    return <ErrorState title="Couldn’t load the activity" message={errorMessage(activity.error)} onRetry={() => void activity.refetch()} />
  if (!activity.data.length)
    return (
      <EmptyState
        icon={<ActivityIcon size={36} />}
        title="No activity yet"
        body={
          campaign.status === 'active'
            ? 'Every action your LinkedIn account takes for this campaign shows up here, usually within a few minutes inside your active hours.'
            : 'Start the campaign – every action your LinkedIn account takes for it shows up here.'
        }
      />
    )
  return (
    <div>
      <p className="mb-2 text-xs text-ink-3">Latest {activity.data.length} actions · updates every 10 seconds</p>
      <ActivityList items={activity.data} showCampaign={false} />
    </div>
  )
}
