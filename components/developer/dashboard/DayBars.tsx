"use client"

import type { DayPoint } from "@/lib/api-v2/dev-dashboard-view"

const HEIGHT = 96

/** Requests per day: successful part navy, failed part rose on top. Plain SVG, no chart library. */
export function DayBars({ points }: { points: DayPoint[] }) {
  const max = Math.max(1, ...points.map((p) => (Number(p.ok) || 0) + (Number(p.failed) || 0)))
  const n = Math.max(1, points.length)
  const slot = 100 / n
  const bar = Math.min(6, slot * 0.7)
  return (
    <div>
      <svg viewBox={`0 0 100 ${HEIGHT}`} preserveAspectRatio="none" className="h-28 w-full" role="img" aria-label="Requests per day">
        {points.map((p, i) => {
          const ok = ((Number(p.ok) || 0) / max) * (HEIGHT - 4)
          const failed = ((Number(p.failed) || 0) / max) * (HEIGHT - 4)
          const x = i * slot + (slot - bar) / 2
          return (
            <g key={p.day}>
              <title>{`${p.day}: ${p.ok} ok, ${p.failed} failed`}</title>
              <rect x={x} y={HEIGHT - ok} width={bar} height={ok} rx={0.8} className="fill-primary" />
              <rect x={x} y={HEIGHT - ok - failed} width={bar} height={failed} rx={0.8} className="fill-rose-500" />
            </g>
          )
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
        <span>{points[0]?.day.slice(5) ?? ""}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-primary" aria-hidden /> OK</span>
          <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-rose-500" aria-hidden /> Failed</span>
        </span>
        <span>{points[points.length - 1]?.day.slice(5) ?? ""}</span>
      </div>
    </div>
  )
}
