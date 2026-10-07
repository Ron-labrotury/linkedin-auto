import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Search, Send, Mail } from 'lucide-react'
import { useStore } from '../store/useStore'
import { cn, formatDateTime, timeAgo } from '../lib/utils'
import { Avatar, Badge, Button, Card, EmptyState, PageHeader, Textarea } from '../components/ui'

export default function Inbox() {
  const { conversations, sendMessage, markRead } = useStore()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | 'unread'>('all')
  const [draft, setDraft] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  const list = conversations
    .filter((c) => (filter === 'all' || c.unread) && c.name.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => (b.messages.at(-1)?.at ?? '').localeCompare(a.messages.at(-1)?.at ?? ''))
  const active = conversations.find((c) => c.id === activeId)

  useEffect(() => {
    if (active?.unread) markRead(active.id)
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [active, markRead])

  const send = () => {
    if (!active || !draft.trim()) return
    sendMessage(active.id, draft.trim())
    setDraft('')
  }

  return (
    <>
      <PageHeader title="Inbox" />
      <Card className="grid h-[calc(100vh-11rem)] min-h-[520px] overflow-hidden md:grid-cols-[360px_1fr]">
        <div className={cn('flex min-h-0 flex-col border-r border-line', active && 'hidden md:flex')}>
          <div className="space-y-3 border-b border-line p-4">
            <div className="relative">
              <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search conversations" className="h-10 w-full rounded-lg border border-line bg-bg/60 pl-10 pr-3 text-sm focus:border-brand focus:outline-none" />
            </div>
            <div className="flex gap-2">
              {(['all', 'unread'] as const).map((f) => (
                <button key={f} onClick={() => setFilter(f)} className={cn('cursor-pointer rounded-full px-3 py-1 text-sm capitalize', filter === f ? 'bg-brand-soft text-brand' : 'text-ink-2 hover:bg-panel-2')}>
                  {f}
                </button>
              ))}
            </div>
          </div>
          <ul className="flex-1 overflow-y-auto">
            {list.map((c) => {
              const last = c.messages.at(-1)
              return (
                <li key={c.id}>
                  <button
                    onClick={() => setActiveId(c.id)}
                    className={cn('flex w-full cursor-pointer gap-3 border-b border-line/60 p-4 text-left hover:bg-panel-2', activeId === c.id && 'bg-panel-2')}
                  >
                    <Avatar name={c.name} size={42} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className={cn('truncate', c.unread ? 'font-semibold' : 'font-medium')}>{c.name}</p>
                        {last && <span className="shrink-0 text-xs text-ink-3">{timeAgo(last.at)}</span>}
                      </div>
                      <p className={cn('truncate text-sm', c.unread ? 'text-ink' : 'text-ink-3')}>
                        {last?.from === 'me' && 'You: '}{last?.text}
                      </p>
                    </div>
                    {c.unread && <span className="mt-2 size-2.5 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
                  </button>
                </li>
              )
            })}
            {!list.length && <p className="p-8 text-center text-sm text-ink-3">No conversations</p>}
          </ul>
        </div>

        <div className={cn('flex min-h-0 flex-col', !active && 'hidden md:flex')}>
          {active ? (
            <>
              <div className="flex items-center gap-3 border-b border-line p-4">
                <button onClick={() => setActiveId(null)} className="cursor-pointer p-1 md:hidden" aria-label="Back"><ArrowLeft size={20} /></button>
                <Avatar name={active.name} size={42} />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{active.name}</p>
                  <p className="truncate text-sm text-ink-3">{active.headline}</p>
                </div>
                {active.campaignName && <Badge tone="brand">{active.campaignName}</Badge>}
              </div>
              <div className="flex-1 space-y-4 overflow-y-auto p-6">
                {active.messages.map((m) => (
                  <div key={m.id} className={cn('flex', m.from === 'me' ? 'justify-end' : 'justify-start')}>
                    <div className={cn('max-w-[75%] rounded-2xl px-4 py-3', m.from === 'me' ? 'rounded-br-md bg-brand text-white' : 'rounded-bl-md bg-panel-2')}>
                      <p className="whitespace-pre-wrap text-sm leading-relaxed">{m.text}</p>
                      <p className={cn('mt-1 text-[11px]', m.from === 'me' ? 'text-white/70' : 'text-ink-3')}>{formatDateTime(m.at)}</p>
                    </div>
                  </div>
                ))}
                <div ref={endRef} />
              </div>
              <div className="flex items-end gap-3 border-t border-line p-4">
                <Textarea
                  rows={2}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      send()
                    }
                  }}
                  placeholder="Write a message… (Enter to send, Shift+Enter for a new line)"
                  className="resize-none"
                />
                <Button onClick={send} disabled={!draft.trim()} aria-label="Send"><Send size={16} /></Button>
              </div>
            </>
          ) : (
            <div className="grid flex-1 place-items-center">
              <EmptyState icon={<Mail size={36} />} title="Select a conversation" body="Replies from your campaigns land here, alongside your other LinkedIn messages." />
            </div>
          )}
        </div>
      </Card>
    </>
  )
}
