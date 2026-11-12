import { cn } from "@/lib/utils"
import type { ClientMessage } from "@/lib/support-client"

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
}

/** User on the right (navy), support (admin or ai) on the left. */
export function MessageBubble({ message }: { message: ClientMessage }) {
  const mine = message.sender_role === "user"
  return (
    <div className={cn("flex", mine ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm lg:max-w-[70%]",
          mine ? "rounded-br-md bg-primary text-primary-foreground" : "rounded-bl-md bg-muted text-foreground",
        )}
      >
        {!mine && <p className="mb-0.5 text-[11px] font-bold text-primary dark:text-foreground/80">Support</p>}
        <p className="whitespace-pre-wrap break-words">{message.body}</p>
        <p className={cn("mt-1 text-right text-[10px]", mine ? "text-primary-foreground/70" : "text-muted-foreground")}>
          {formatTime(message.created_at)}
        </p>
      </div>
    </div>
  )
}
