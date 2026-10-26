"use client"

import { Award, Crown, Medal, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatCedis, type PublicEntry } from "@/lib/leaderboard/public"

interface Step {
  rank: 1 | 2 | 3
  icon: LucideIcon
  height: string
  block: string
  badge: string
}

// Rendered left-to-right as 2 · 1 · 3, like a real podium.
const STEPS: Step[] = [
  {
    rank: 2,
    icon: Medal,
    height: "h-36 sm:h-40",
    block: "bg-gradient-to-b from-slate-100 to-slate-300 text-slate-800 shadow-[0_14px_30px_-12px_rgba(148,163,184,0.7)]",
    badge: "bg-gradient-to-b from-slate-100 to-slate-300 text-slate-700",
  },
  {
    rank: 1,
    icon: Crown,
    height: "h-44 sm:h-48",
    block: "bg-gradient-to-b from-amber-200 to-amber-400 text-amber-950 shadow-[0_18px_36px_-10px_rgba(251,191,36,0.75)]",
    badge: "bg-gradient-to-b from-amber-200 to-amber-400 text-amber-900 shadow-[0_0_28px_rgba(251,191,36,0.55)]",
  },
  {
    rank: 3,
    icon: Award,
    height: "h-32 sm:h-36",
    block: "bg-gradient-to-b from-orange-200 to-orange-400 text-orange-950 shadow-[0_14px_30px_-12px_rgba(251,146,60,0.7)]",
    badge: "bg-gradient-to-b from-orange-200 to-orange-400 text-orange-900",
  },
]

export function Podium({ entries }: { entries: PublicEntry[] }) {
  const byRank = new Map(entries.filter((e) => e.rank <= 3).map((e) => [e.rank, e]))

  return (
    <div className="grid grid-cols-3 items-end gap-2 sm:gap-3" role="list" aria-label="Top 3">
      {STEPS.map((step) => {
        const entry = byRank.get(step.rank)
        const Icon = step.icon
        return (
          <div key={step.rank} role="listitem" className="flex min-w-0 flex-col items-center gap-3">
            <div className={cn("clay-icon flex h-14 w-14 items-center justify-center rounded-full sm:h-16 sm:w-16", step.badge)}>
              <Icon className="h-7 w-7" strokeWidth={2.25} aria-hidden />
            </div>
            <div
              className={cn(
                "flex w-full flex-col items-center justify-center rounded-3xl px-1.5 text-center",
                step.height,
                entry ? step.block : "clay-inset text-muted-foreground",
                entry?.isMe && "ring-2 ring-primary ring-offset-2 ring-offset-card",
              )}
            >
              <span className="text-4xl font-black leading-none sm:text-5xl">{step.rank}</span>
              {entry ? (
                <>
                  <span className="mt-2 w-full truncate text-sm font-bold sm:text-base" title={entry.name}>
                    {entry.isMe ? "You" : entry.name}
                  </span>
                  <span className="mt-0.5 text-[11px] font-semibold leading-tight opacity-80 sm:text-xs">
                    {formatCedis(entry.total)}
                  </span>
                </>
              ) : (
                <span className="mt-2 text-xs">Open spot</span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
