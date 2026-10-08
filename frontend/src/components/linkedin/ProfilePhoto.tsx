import { useState } from 'react'
import { cn } from '../../lib/utils'
import { Avatar } from '../ui'

/** LinkedIn profile photo, falling back to initials when there is none or it fails to load. */
export function ProfilePhoto({ name, src, size = 48, className }: { name: string; src?: string | null; size?: number; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null)
  if (!src || failed === src) return <Avatar name={name || '?'} size={size} className={className} />
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      referrerPolicy="no-referrer"
      onError={() => setFailed(src)}
      className={cn('shrink-0 rounded-full bg-panel-2 object-cover', className)}
      style={{ width: size, height: size }}
    />
  )
}
