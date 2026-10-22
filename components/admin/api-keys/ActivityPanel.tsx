"use client"

import { useCallback, useEffect, useState } from "react"
import { BarChart3 } from "lucide-react"
import { formatDistanceToNowStrict } from "date-fns"
import { cn } from "@/lib/utils"
import { formatCount, formatLatency, formatPercent } from "@/lib/api-v2/admin-view"
import type { KeyActivity } from "@/lib/api-v2/admin-stats"
import { loadActivity } from "./use-console-data"
import { InlineError } from "./ui"

/** Spent/orders are typed `null` until plan 3; their tiles render only when a number arrives. */
type MaybeMoney = { spent: number | null; orders: number | null }

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-background px-3 py-2.5 dark:bg-white/[0.03]">
      <p className="truncate text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 truncate text-base font-bold tabular-nums text-foreground", cls)}>{value}</p>
    </div>
  )
}

export function ActivityView({ activity }: { activity: KeyActivity }) {
  const a = activity
  const m = a as unknown as MaybeMoney
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {typeof m.spent === "number" && <Stat label="Spent" value={`GHC ${formatCount(m.spent)}`} />}
      {typeof m.orders === "number" && <Stat label="Orders" value={formatCount(m.orders)} />}
      <Stat label="Reqs (24h)" value={formatCount(a.requests)} />
      <Stat label="Success" value={formatCount(a.ok)} cls="text-emerald-600 dark:text-emerald-400" />
      <Stat label="Failed" value={formatCount(a.failed)} cls={a.failed > 0 ? "text-rose-600 dark:text-rose-400" : undefined} />
      <Stat label="Success rate" value={formatPercent(a.successRate)} />
      <Stat label="Avg latency" value={formatLatency(a.avgLatencyMs)} />
      <Stat
        label="Last request"
        value={a.lastUsedAt ? `${formatDistanceToNowStrict(new Date(a.lastUsedAt))} ago` : "None in 24h"}
      />
    </div>
  )
}

export function ActivityPanel({ keyId, preset }: { keyId: string; preset?: KeyActivity }) {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; activity: KeyActivity }
  >(preset ? { kind: "ready", activity: preset } : { kind: "loading" })

  const load = useCallback(async () => {
    setState({ kind: "loading" })
    const r = await loadActivity(keyId)
    if (r.ok && r.data?.activity) setState({ kind: "ready", activity: r.data.activity })
    else setState({ kind: "error", message: r.error ?? "Activity unavailable" })
  }, [keyId])

  useEffect(() => {
    if (!preset) void load()
  }, [load, preset])

  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/50 p-3 dark:bg-white/[0.02]">
      <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <BarChart3 className="size-4 text-primary" aria-hidden />
        User Activity
        <span className="font-normal text-muted-foreground">· last 24h</span>
      </p>
      {state.kind === "loading" && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Loading activity">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-[58px] animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      )}
      {state.kind === "error" && <InlineError message={`Could not load activity: ${state.message}`} onRetry={load} />}
      {state.kind === "ready" && <ActivityView activity={state.activity} />}
    </div>
  )
}
