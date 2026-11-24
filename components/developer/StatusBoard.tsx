"use client"

import { useEffect, useState } from "react"
import { CheckCircle2, CircleDashed, PauseCircle, TriangleAlert } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { PublicStatus, ServiceState } from "@/lib/api-v2/status-public"
import { cn } from "@/lib/utils"

const STATE: Record<ServiceState, { label: string; icon: LucideIcon; tone: string }> = {
  operational: { label: "Operational", icon: CheckCircle2, tone: "text-emerald-700 dark:text-emerald-300 border-emerald-500/30 bg-emerald-500/[0.06]" },
  degraded: { label: "Degraded", icon: TriangleAlert, tone: "text-amber-700 dark:text-amber-300 border-amber-500/40 bg-amber-500/[0.08]" },
  paused: { label: "Paused", icon: PauseCircle, tone: "text-rose-700 dark:text-rose-300 border-rose-500/40 bg-rose-500/[0.08]" },
  no_data: { label: "Not enough traffic yet", icon: CircleDashed, tone: "text-muted-foreground border-border bg-muted/40" },
}

function when(iso: string) {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " GMT"
}

/** Per-service state, an icon and a word for each (never colour alone), and the 24 h success rate only. */
export function StatusBoardView({ status, loading, error }: { status: PublicStatus | null; loading: boolean; error: string | null }) {
  if (error && !status) {
    return <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">We could not load the status just now. Please try again in a minute.</p>
  }
  if (!status) return <div className="h-48 animate-pulse rounded-2xl bg-muted" aria-label={loading ? "Loading the status" : undefined} />
  return (
    <div className="space-y-3">
      <ul className="grid gap-3 sm:grid-cols-2">
        {status.services.map((s) => {
          const st = STATE[s.state]
          const Icon = st.icon
          return (
            <li key={s.id} className="rounded-2xl border border-border bg-card p-4 dark:bg-white/[0.03]">
              <div className="flex items-start justify-between gap-3">
                <p className="font-semibold text-foreground">{s.title}</p>
                <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-bold", st.tone)}>
                  <Icon className="size-3.5" aria-hidden />
                  {st.label}
                </span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {s.successRate24h === null ? "Success rate shows once there is enough traffic." : `${s.successRate24h}% of requests succeeded in the last 24 hours.`}
              </p>
              {s.message && <p className="mt-2 whitespace-pre-line break-words rounded-lg bg-muted/60 px-3 py-2 text-sm text-foreground">{s.message}</p>}
            </li>
          )
        })}
      </ul>
      <p className="text-xs text-muted-foreground">Updated {when(status.generatedAt)}. Refreshes every minute. 4xx responses (mistakes in a request) do not count as failures.</p>
    </div>
  )
}

/** Fetches the public status; refetches at most once a minute while the page is open. Failures keep the last view. */
export function StatusBoard() {
  const [status, setStatus] = useState<PublicStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let ctrl = new AbortController()
    const load = () => {
      ctrl.abort()
      ctrl = new AbortController()
      fetch("/api/developers/status", { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: PublicStatus) => {
          setStatus(d)
          setError(null)
        })
        .catch((e: unknown) => {
          if ((e as { name?: string })?.name !== "AbortError") setError("unavailable")
        })
    }
    load()
    const t = setInterval(load, 60_000)
    return () => {
      clearInterval(t)
      ctrl.abort()
    }
  }, [])

  return <StatusBoardView status={status} loading={!status && !error} error={error} />
}
