"use client"

import { useEffect, useState } from "react"
import { Loader2, Trophy } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BOARD_COPY, formatCedis } from "@/lib/leaderboard/public"
import type { Board, PeriodKind } from "@/lib/leaderboard/periods"
import type { MyRank } from "@/lib/leaderboard/service"
import { leaderboardFetch } from "./api"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  board: Board
  kind: PeriodKind
  anchor: string
  periodLabel: string
}

export function MyRankDialog({ open, onOpenChange, board, kind, anchor, periodLabel }: Props) {
  const [rank, setRank] = useState<MyRank | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError("")
    setRank(null)
    const qs = new URLSearchParams({ board, kind, anchor })
    leaderboardFetch<{ paused: boolean; message?: string; rank?: MyRank }>(`/api/leaderboard/me?${qs}`).then((res) => {
      if (cancelled) return
      setLoading(false)
      if (!res.ok) setError(res.error)
      else if (res.data.paused || !res.data.rank) setError(res.data.message ?? "Rank unavailable right now.")
      else setRank(res.data.rank)
    })
    return () => { cancelled = true }
  }, [open, board, kind, anchor])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="clay max-w-sm border-0">
        <DialogHeader>
          <DialogTitle>Your rank</DialogTitle>
          <DialogDescription>{BOARD_COPY[board].title} · {periodLabel}</DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        )}
        {error && <p className="py-4 text-sm text-destructive">{error}</p>}

        {rank && (
          <div className="space-y-4">
            {rank.rank !== null ? (
              <div className="clay-inset flex items-center gap-4 rounded-3xl p-4">
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-primary text-2xl font-black text-primary-foreground clay-btn">
                  #{rank.rank}
                </div>
                <div className="min-w-0">
                  <p className="text-sm text-muted-foreground">of {rank.participants.toLocaleString("en-US")} sellers</p>
                  <p className="text-xl font-bold text-foreground">{formatCedis(rank.total)}</p>
                  <p className="text-xs text-muted-foreground">{rank.orders.toLocaleString("en-US")} completed {rank.orders === 1 ? "order" : "orders"}</p>
                </div>
              </div>
            ) : (
              <div className="clay-inset rounded-3xl p-4 text-sm text-muted-foreground">
                You have no counted sales for {periodLabel} yet.
              </div>
            )}

            <ul className="space-y-2 text-sm">
              {rank.rank !== null && rank.rank <= 3 && (
                <li className="flex items-center gap-2 font-semibold text-foreground">
                  <Trophy className="h-4 w-4 text-amber-500" /> You&apos;re on the podium. Keep it up!
                </li>
              )}
              {rank.gapToNext !== null && rank.rank !== null && (
                <li className="text-foreground">
                  About <span className="font-bold">{formatCedis(rank.gapToNext)}</span> more to pass #{rank.rank - 1}.
                </li>
              )}
              {rank.gapToTop3 !== null && (
                <li className="text-foreground">
                  About <span className="font-bold">{formatCedis(rank.gapToTop3)}</span> more to reach #3.
                </li>
              )}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
