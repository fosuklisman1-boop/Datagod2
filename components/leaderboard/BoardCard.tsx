"use client"

import { useState } from "react"
import { CalendarClock, Info, LayoutGrid, RefreshCw, Search, Store } from "lucide-react"
import { cn } from "@/lib/utils"
import { BOARD_COPY, NOT_COUNTED_NOTE, formatCedis, type PeriodView, type PublicBoard } from "@/lib/leaderboard/public"
import type { Board } from "@/lib/leaderboard/periods"
import { Podium } from "./Podium"
import { MyRankDialog } from "./MyRankDialog"

const ICONS: Record<Board, { icon: typeof Store; tile: string }> = {
  dashboard: { icon: LayoutGrid, tile: "bg-gradient-to-br from-blue-400 to-indigo-500 text-white" },
  shop: { icon: Store, tile: "bg-gradient-to-br from-emerald-300 to-teal-500 text-teal-950" },
}

interface Props {
  board: Board
  data: PublicBoard
  period: PeriodView
  refreshing: boolean
  onRefresh: () => void
}

export function BoardCard({ board, data, period, refreshing, onRefresh }: Props) {
  const [rankOpen, setRankOpen] = useState(false)
  const copy = BOARD_COPY[board]
  const { icon: Icon, tile } = ICONS[board]
  const rest = data.entries.filter((e) => e.rank > 3)

  return (
    <section className="clay space-y-6 p-5 sm:p-6" aria-labelledby={`board-${board}`}>
      <header className="flex items-start gap-4">
        <div className={cn("clay-icon flex h-14 w-14 shrink-0 items-center justify-center", tile)}>
          <Icon className="h-7 w-7" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h2 id={`board-${board}`} className="text-xl font-extrabold text-foreground">{copy.title}</h2>
          <p className="text-sm text-muted-foreground">{copy.subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="clay-sm flex h-11 w-11 shrink-0 items-center justify-center text-foreground disabled:opacity-60"
          aria-label={`Refresh ${copy.title.toLowerCase()}`}
        >
          <RefreshCw className={cn("h-5 w-5", refreshing && "animate-spin")} />
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-base font-semibold text-muted-foreground">{period.label}</span>
        {period.timeLeft ? (
          <span className="clay-btn inline-flex items-center gap-1.5 rounded-full bg-amber-400 px-3 py-1 text-sm font-bold text-amber-950">
            <CalendarClock className="h-4 w-4" aria-hidden /> {period.timeLeft}
          </span>
        ) : period.ended ? (
          <span className="clay-inset inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold text-muted-foreground">Ended</span>
        ) : null}
      </div>

      <p className="text-sm text-muted-foreground">{copy.rule}</p>

      {data.entries.length === 0 ? (
        <div className="clay-inset rounded-3xl px-4 py-10 text-center text-sm text-muted-foreground">
          No completed sales for {period.label} yet. Be the first on the board!
        </div>
      ) : (
        <>
          <Podium entries={data.entries} />
          {rest.length > 0 && (
            <ol className="clay-inset space-y-1 rounded-3xl p-2 sm:p-3">
              {rest.map((e) => (
                <li
                  key={e.rank}
                  className={cn("flex items-center gap-3 rounded-2xl px-2 py-2", e.isMe && "bg-primary/10")}
                  aria-current={e.isMe ? "true" : undefined}
                >
                  <span className="clay-sm flex h-10 w-10 shrink-0 items-center justify-center text-sm font-bold text-foreground">
                    {e.rank}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-semibold text-foreground">
                    {e.name}{e.isMe && <span className="ml-1.5 text-xs font-bold text-primary">(You)</span>}
                  </span>
                  <span className="shrink-0 text-sm font-medium tabular-nums text-muted-foreground">{formatCedis(e.total)}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}

      <button
        type="button"
        onClick={() => setRankOpen(true)}
        className="clay-btn flex h-14 w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-indigo-300 via-blue-400 to-indigo-400 text-lg font-bold text-slate-900"
      >
        <Search className="h-5 w-5" aria-hidden /> Check my rank
      </button>

      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {NOT_COUNTED_NOTE}
      </p>

      <MyRankDialog
        open={rankOpen}
        onOpenChange={setRankOpen}
        board={board}
        kind={period.kind}
        anchor={period.range.start}
        periodLabel={period.label}
      />
    </section>
  )
}
