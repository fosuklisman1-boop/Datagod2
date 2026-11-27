"use client"

import { useRef } from "react"
import { Hourglass } from "lucide-react"
import { queueHeading, queueProgress } from "@/lib/ai-voice/queue-view"
import type { VoiceCall } from "./CallPanel"

/**
 * Shown above the chat input while the caller waits in the line (state "queued"). The chat stays usable underneath:
 * the call starts by itself on their turn. On `lg:` the text and the leave button sit side by side.
 */
export function QueueWaitPanel({ call, name }: { call: VoiceCall; name: string }) {
  const place = call.queue?.position ?? 1
  const eta = call.queue?.etaSeconds ?? 0
  // Where the caller joined: the bar shows how far they have moved up from there.
  const startRef = useRef(place)
  if (call.state !== "queued") startRef.current = place
  else if (place > startRef.current) startRef.current = place
  const pct = queueProgress(startRef.current, place)

  return (
    <div
      role="status"
      aria-live="polite"
      data-call-state="queued"
      className="border-t border-border bg-muted/40 p-4 lg:flex lg:items-center lg:gap-6 lg:p-5"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Hourglass size={18} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{queueHeading(place, eta)}</p>
          <div
            role="progressbar"
            aria-label="Progress in the line"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className="mt-2 h-2 w-full overflow-hidden rounded-full bg-primary/15"
          >
            <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Your call starts by itself on your turn. You can keep typing to {name} while you wait.
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={call.hangUp}
        className="mt-3 flex h-10 w-full items-center justify-center rounded-full border border-primary/30 bg-card px-5 text-sm font-semibold text-primary transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary lg:mt-0 lg:w-auto"
      >
        Leave the line
      </button>
    </div>
  )
}
