"use client"

import { cn } from "@/lib/utils"
import { QUEUE_VIEWS, type QueueView } from "@/lib/order-queue/types"

export const QUEUE_VIEW_LABELS: Record<QueueView, string> = {
  needs_action: "Needs action",
  held: "Held",
  stuck: "Stuck",
  failed: "Failed",
  all: "All",
}

export type QueueTabsProps = {
  view: QueueView
  /** Live counts from the queue API; null while the first load is in flight. */
  counts: Record<QueueView, number> | null
  onChange: (view: QueueView) => void
}

export function QueueTabs({ view, counts, onChange }: QueueTabsProps) {
  return (
    <div role="tablist" aria-label="Order views" className="flex gap-1 overflow-x-auto rounded-lg bg-muted p-1">
      {QUEUE_VIEWS.map((v) => {
        const active = v === view
        return (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={active}
            data-view={v}
            onClick={() => onChange(v)}
            className={cn(
              "flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-background hover:text-foreground",
            )}
          >
            {QUEUE_VIEW_LABELS[v]}
            <span
              data-count={v}
              className={cn(
                "min-w-[1.5rem] rounded-full px-1.5 text-center text-xs tabular-nums",
                active ? "bg-primary-foreground/20" : "bg-background",
              )}
            >
              {counts ? counts[v].toLocaleString() : "…"}
            </span>
          </button>
        )
      })}
    </div>
  )
}
