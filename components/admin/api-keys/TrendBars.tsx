"use client"

import { TrendingUp } from "lucide-react"
import { trendBars } from "@/lib/api-v2/console-tabs"
import { Eyebrow, IconChip, InlineError, Panel } from "./ui"

export interface TrendPoint {
  day: string
  requests: number
  ok: number
  failed: number
  revenue: number
}

const HEIGHT = 96
const BAR = 10
const GAP = 4

const ghs = (n: number) => `GHS ${n.toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Simple SVG bars: total requests per day (navy) with the failed part on top (rose). No chart library. */
export function TrendBarsView({ points, loading, error, onRetry }: { points: TrendPoint[]; loading: boolean; error: string | null; onRetry: () => void }) {
  const bars = trendBars(points, HEIGHT)
  const totals = points.reduce((s, p) => ({ requests: s.requests + p.requests, failed: s.failed + p.failed, revenue: s.revenue + p.revenue }), { requests: 0, failed: 0, revenue: 0 })
  const width = Math.max(1, bars.length * (BAR + GAP))
  return (
    <Panel className="space-y-4">
      <div className="flex items-start gap-3">
        <IconChip icon={TrendingUp} />
        <div className="min-w-0 flex-1">
          <Eyebrow>API v2</Eyebrow>
          <h2 className="text-base font-bold text-foreground">30-day trend</h2>
          <p className="text-sm text-muted-foreground">Requests per day, with failures in red. Revenue counts data orders only.</p>
        </div>
      </div>
      {error ? (
        <InlineError message={`The trend could not be loaded: ${error}`} onRetry={onRetry} />
      ) : loading && points.length === 0 ? (
        <div className="h-24 animate-pulse rounded-xl bg-muted" aria-label="Loading the trend" />
      ) : bars.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">No API traffic in the last 30 days.</p>
      ) : (
        <>
          <svg viewBox={`0 0 ${width} ${HEIGHT}`} preserveAspectRatio="none" className="h-24 w-full" role="img" aria-label="Requests per day for the last 30 days">
            {bars.map((b) => {
              const x = b.x * (BAR + GAP)
              return (
                <g key={b.x}>
                  <title>{b.label}</title>
                  <rect x={x} y={HEIGHT - b.h} width={BAR} height={b.h} rx={2} className="fill-primary/70" />
                  {b.failedH > 0 && <rect x={x} y={HEIGHT - b.h} width={BAR} height={b.failedH} rx={2} className="fill-rose-500" />}
                </g>
              )
            })}
          </svg>
          <dl className="grid grid-cols-3 gap-2 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Requests</dt>
              <dd className="font-semibold tabular-nums text-foreground">{totals.requests.toLocaleString("en-GH")}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Failed</dt>
              <dd className="font-semibold tabular-nums text-foreground">{totals.failed.toLocaleString("en-GH")}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Data revenue</dt>
              <dd className="font-semibold tabular-nums text-foreground">{ghs(totals.revenue)}</dd>
            </div>
          </dl>
        </>
      )}
    </Panel>
  )
}
