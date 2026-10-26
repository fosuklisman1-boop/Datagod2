"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { CalendarDays, ChevronLeft, ChevronRight, Wrench } from "lucide-react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { PERIOD_KINDS, type PeriodKind } from "@/lib/leaderboard/periods"
import { countingRule, headerTitle, rewardLine, type PeriodView, type PublicBoard, type PublicRewards } from "@/lib/leaderboard/public"
import { BoardCard } from "./BoardCard"
import { leaderboardFetch } from "./api"

type Payload =
  | { paused: true; message: string }
  | { paused: false; period: PeriodView; boards: { dashboard: PublicBoard; shop: PublicBoard }; rewards: PublicRewards | null }

const KIND_LABEL: Record<PeriodKind, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly" }

export function TopPerformersPage() {
  const [kind, setKind] = useState<PeriodKind>("monthly")
  const [anchor, setAnchor] = useState<string | null>(null)
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)

  const load = useCallback(async () => {
    const mine = ++seq.current
    setLoading(true)
    setError("")
    const qs = new URLSearchParams({ kind })
    if (anchor) qs.set("anchor", anchor)
    const res = await leaderboardFetch<Payload>(`/api/leaderboard?${qs}`)
    if (mine !== seq.current) return
    setLoading(false)
    if (res.ok) setData(res.data)
    else setError(res.error)
  }, [kind, anchor])

  useEffect(() => { load() }, [load])

  const chooseKind = (next: PeriodKind) => {
    if (next === kind) return
    setKind(next)
    setAnchor(null)
    setData(null)
  }

  const period = data && !data.paused ? data.period : null

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-5xl space-y-6 pb-8">
        <div className="space-y-3">
          <h1 className="text-3xl font-black tracking-tight text-foreground sm:text-4xl">{headerTitle(kind)}</h1>
          {data && !data.paused && data.rewards && <p className="text-base font-semibold text-foreground">{rewardLine(kind)}</p>}
          <p className="text-base text-muted-foreground">{countingRule(kind)}</p>
        </div>

        <div className="clay-inset grid grid-cols-4 gap-1 rounded-full p-1" role="tablist" aria-label="Period">
          {PERIOD_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={k === kind}
              onClick={() => chooseKind(k)}
              className={cn(
                "rounded-full py-2 text-sm font-semibold transition-colors",
                k === kind ? "bg-primary text-primary-foreground clay-btn" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => period && setAnchor(period.prevAnchor)}
            disabled={!period || loading}
            className="clay-sm flex h-11 w-11 shrink-0 items-center justify-center text-foreground disabled:opacity-50"
            aria-label="Previous period"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div className="clay-sm inline-flex h-11 min-w-0 items-center gap-2 px-5 font-bold text-foreground">
            <CalendarDays className="h-5 w-5 shrink-0" aria-hidden />
            <span className="truncate">{period?.label ?? "…"}</span>
          </div>
          <button
            type="button"
            onClick={() => period?.nextAnchor && setAnchor(period.nextAnchor)}
            disabled={!period?.nextAnchor || loading}
            className="clay-sm flex h-11 w-11 shrink-0 items-center justify-center text-foreground disabled:opacity-50"
            aria-label="Next period"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>

        {error && !data && (
          <div className="clay space-y-3 p-6 text-center">
            <p className="text-sm text-destructive">{error}</p>
            <button type="button" onClick={load} className="clay-sm px-5 py-2 text-sm font-semibold text-foreground">Try again</button>
          </div>
        )}

        {data?.paused && (
          <div className="clay flex flex-col items-center gap-3 p-8 text-center">
            <div className="clay-icon flex h-14 w-14 items-center justify-center bg-amber-300 text-amber-950">
              <Wrench className="h-7 w-7" aria-hidden />
            </div>
            <p className="max-w-sm text-base font-semibold text-foreground">{data.message}</p>
          </div>
        )}

        {!data && !error && (
          <div className="grid gap-6 lg:grid-cols-2">
            {[0, 1].map((i) => <Skeleton key={i} className="h-[560px] rounded-[2rem]" />)}
          </div>
        )}

        {data && !data.paused && (
          <div className="grid items-start gap-6 lg:grid-cols-2">
            <BoardCard board="dashboard" data={data.boards.dashboard} period={data.period} prizes={data.rewards?.dashboard} refreshing={loading} onRefresh={load} />
            <BoardCard board="shop" data={data.boards.shop} period={data.period} prizes={data.rewards?.shop} refreshing={loading} onRefresh={load} />
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
