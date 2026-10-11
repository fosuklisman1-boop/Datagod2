"use client"
import type { OverviewData } from "../_lib/api"
import { formatCount, formatGhs, formatRate, providerLabel, supplyHeadline } from "../_lib/view"

export default function SupplyStrip({ overview }: { overview: OverviewData }) {
  const s = overview.supply
  return (
    <div className="clay-inset flex flex-wrap items-center gap-x-6 gap-y-1 rounded-2xl px-4 py-3 text-sm">
      <span className="font-medium">Supply · {providerLabel(overview.provider)}</span>
      <span className={s.error ? "text-amber-700 dark:text-amber-300" : ""}>{supplyHeadline(s)}</span>
      {s.balanceGhs !== null && <span className="text-muted-foreground">Balance {formatGhs(s.balanceGhs)}</span>}
      {s.ratePerSms !== null && <span className="text-muted-foreground">Rate {formatRate(s.ratePerSms)}/SMS</span>}
      {s.queuedUnsent !== null && <span className="text-muted-foreground">{formatCount(s.queuedUnsent)} queued, not yet sent</span>}
    </div>
  )
}
