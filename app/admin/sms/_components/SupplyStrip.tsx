"use client"
import type { OverviewData } from "../_lib/api"
import { formatCount, formatGhs, formatGmt, formatRate, supplyHeadline } from "../_lib/view"
import { supplyProviderLabel } from "../_lib/hubtel-balance-view"

export default function SupplyStrip({ overview }: { overview: OverviewData }) {
  const s = overview.supply
  const manual = s.balanceSource === "manual"
  return (
    <div className="clay-inset flex flex-wrap items-center gap-x-6 gap-y-1 rounded-2xl px-4 py-3 text-sm">
      <span className="font-medium">Supply · {supplyProviderLabel(overview.provider, s)}</span>
      <span className={s.error ? "text-amber-700 dark:text-amber-300" : ""}>{supplyHeadline(s)}</span>
      {s.balanceGhs !== null && <span className="text-muted-foreground">{manual ? "Estimated balance" : "Balance"} {formatGhs(s.balanceGhs)}</span>}
      {manual && s.manualSetAt && <span className="text-muted-foreground">Manual balance set {formatGmt(s.manualSetAt)}</span>}
      {s.ratePerSms !== null && <span className="text-muted-foreground">Rate {formatRate(s.ratePerSms)}/SMS</span>}
      {s.queuedUnsent !== null && <span className="text-muted-foreground">{formatCount(s.queuedUnsent)} queued, not yet sent</span>}
    </div>
  )
}
