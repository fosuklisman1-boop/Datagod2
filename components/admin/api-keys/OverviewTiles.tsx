import { Activity, CheckCircle2, Clock, Crown, Gauge, KeyRound, ShieldCheck, Wallet, XCircle, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatCount, formatLatency, formatPercent, statusCounts, type ConsoleKey } from "@/lib/api-v2/admin-view"
import type { AdminStats } from "@/lib/api-v2/admin-stats"
import { Eyebrow, IconChip, InlineError, Panel, type Tone } from "./ui"

function Tile({
  icon,
  tone,
  label,
  value,
  sub,
  valueCls,
  className,
}: {
  icon: LucideIcon
  tone: Tone
  label: string
  value: string
  sub?: React.ReactNode
  valueCls?: string
  className?: string
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm dark:bg-white/[0.03]", className)}>
      <div className="flex items-center gap-2.5">
        <IconChip icon={icon} tone={tone} className="size-8 rounded-lg" />
        <Eyebrow className="min-w-0 truncate">{label}</Eyebrow>
      </div>
      <div className="min-w-0">
        <p className={cn("truncate font-display text-2xl font-bold tabular-nums text-foreground sm:text-[28px]", valueCls)}>{value}</p>
        {sub ? <div className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</div> : null}
      </div>
    </div>
  )
}

/** Revenue is typed `null` until plan 3 attributes orders to keys; the tile renders only when a number arrives. */
type MaybeRevenue = { revenue24h: number | null; revenueLifetime: number | null }

export function OverviewTiles({
  keys,
  stats,
  statsError,
  loading,
  onRetry,
}: {
  keys: ConsoleKey[]
  stats: AdminStats | null
  statsError: string | null
  loading: boolean
  onRetry: () => void
}) {
  const c = statusCounts(keys)
  const v1 = keys.filter((k) => k.source === "v1").length
  const s = stats
  const rev = s as MaybeRevenue | null
  const showRevenue = typeof rev?.revenue24h === "number"
  const dash = loading && !s ? "…" : "—"
  const val = (f: (x: AdminStats) => string) => (s ? f(s) : dash)

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile icon={KeyRound} tone="primary" label="Total keys" value={formatCount(c.all)} sub={`${c.all - v1} v2 · ${v1} v1`} />
        <Tile icon={Clock} tone="amber" label="Pending" value={formatCount(c.pending)} valueCls={c.pending > 0 ? "text-amber-600 dark:text-amber-400" : undefined} sub="Awaiting approval" />
        <Tile icon={ShieldCheck} tone="green" label="Active keys" value={formatCount(c.active)} valueCls="text-emerald-600 dark:text-emerald-400" sub={`${c.revoked} revoked`} />
        <Tile icon={Activity} tone="primary" label="Requests (24h)" value={val((x) => formatCount(x.requests24h))} sub="v2 API traffic" />
        {showRevenue && (
          <Tile
            icon={Wallet}
            tone="green"
            label="Revenue (24h)"
            value={`GHC ${formatCount(rev!.revenue24h)}`}
            sub={typeof rev!.revenueLifetime === "number" ? `GHC ${formatCount(rev!.revenueLifetime)} lifetime` : undefined}
          />
        )}
        <Tile
          icon={CheckCircle2}
          tone="green"
          label="Success rate (24h)"
          value={val((x) => formatPercent(x.successRate))}
          sub={!s ? "Unavailable" : s.requests24h > 0 ? `of ${formatCount(s.requests24h)} requests` : "No requests yet"}
        />
        <Tile
          icon={XCircle}
          tone="red"
          label="Failed (24h)"
          value={val((x) => formatCount(x.failed24h))}
          sub={
            <span className="inline-flex items-center gap-1.5">
              <span className={cn("size-1.5 rounded-full", !s ? "bg-muted-foreground/50" : s.failed24h > 0 ? "bg-rose-500" : "bg-emerald-500")} aria-hidden />
              {s ? (s.failed24h > 0 ? "Needs a look" : "All clear") : "Unavailable"}
            </span>
          }
        />
        <Tile
          icon={Gauge}
          tone="slate"
          label="Avg latency"
          value={val((x) => formatLatency(x.avgLatencyMs))}
          sub={s?.top ? `Top: ${s.top.name ?? s.top.email ?? "Unknown user"}` : "24h average"}
          className={showRevenue ? undefined : "col-span-2 lg:col-span-1"}
        />
        {s?.top && (
          <Panel className="col-span-2 flex items-center gap-4 lg:col-span-1 lg:p-4">
            <IconChip icon={Crown} tone="amber" className="size-11 rounded-2xl lg:hidden" />
            <div className="min-w-0 flex-1">
              <Eyebrow className="flex items-center gap-1.5 truncate">
                <Crown className="hidden size-3.5 shrink-0 text-amber-500 lg:block" aria-hidden />
                Top API user (24h)
              </Eyebrow>
              <p className="mt-1 truncate font-semibold text-foreground">{s.top.name ?? "Unknown user"}</p>
              {s.top.email && <p className="truncate text-sm text-muted-foreground">{s.top.email}</p>}
            </div>
            <div className="shrink-0 text-right">
              <p className="font-display text-2xl font-bold tabular-nums text-primary">{formatCount(s.top.requests)}</p>
              <p className="text-xs text-muted-foreground">requests</p>
            </div>
          </Panel>
        )}
      </div>

      {statsError && <InlineError message={`Traffic stats unavailable: ${statsError}`} onRetry={onRetry} />}
    </div>
  )
}
