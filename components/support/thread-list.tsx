import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { countUnread, type ClientMessage, type ClientThread } from "@/lib/support-client"
import { formatTime } from "./message-bubble"

interface Props {
  threads: ClientThread[]
  messagesByThread: Record<string, ClientMessage[]>
  selectedId: string | null
  onSelect: (id: string) => void
}

export function ThreadList({ threads, messagesByThread, selectedId, onSelect }: Props) {
  if (threads.length === 0) {
    return <p className="p-6 text-center text-sm text-muted-foreground">No conversations yet. Tap New Complaint to start one.</p>
  }
  return (
    <ul className="divide-y divide-border">
      {threads.map((t) => {
        const unread = t.id === selectedId ? 0 : countUnread(messagesByThread[t.id])
        return (
          <li key={t.id}>
            <button
              onClick={() => onSelect(t.id)}
              className={cn(
                "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50",
                t.id === selectedId && "bg-primary/5",
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-foreground">{t.subject}</p>
                <p className="mt-0.5 text-xs capitalize text-muted-foreground">
                  {t.category} · {formatTime(t.last_message_at)}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Badge className={t.status === "open" ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"}>
                  {t.status === "open" ? "Open" : "Closed"}
                </Badge>
                {unread > 0 && (
                  <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-bold text-primary-foreground">
                    {unread}
                  </span>
                )}
              </div>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
