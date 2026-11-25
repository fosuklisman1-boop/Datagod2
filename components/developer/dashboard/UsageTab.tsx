"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { BarChart3, ListChecks, TriangleAlert } from "lucide-react"
import { Eyebrow, IconChip, InlineError, Panel, Segmented } from "@/components/admin/api-keys/ui"
import { latestGate, reasonLabel, usageTotals } from "@/lib/api-v2/dev-dashboard-view"
import { PRODUCT_LABEL, type OrderProduct } from "@/lib/api-v2/dev-dashboard"
import { DayBars } from "./DayBars"
import { dashJson } from "./dash-fetch"
import type { Usage } from "./OverviewTab"

type Days = "7" | "30"
type Env = "all" | "live" | "test"

export function UsageTab() {
  const [days, setDays] = useState<Days>("7")
  const [env, setEnv] = useState<Env>("all")
  const [usage, setUsage] = useState<Usage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const gate = useRef(latestGate())
  const load = useCallback(async () => {
    const ticket = gate.current.next()
    setLoading(true)
    const r = await dashJson<Usage>(`/api/user/v2-dashboard/usage?days=${days}${env === "all" ? "" : `&env=${env}`}`)
    if (!gate.current.isLatest(ticket)) return // a newer period or key filter was asked for meanwhile
    setLoading(false)
    if (!r.ok) return setError(r.error)
    setError(null)
    setUsage(r.data)
  }, [days, env])
  useEffect(() => void load(), [load])

  const t = usageTotals(usage?.daily ?? [])
  const orders = Object.entries(usage?.orders ?? {})

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Period" value={days} onChange={setDays} options={[{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }]} />
        <Segmented label="Keys" value={env} onChange={setEnv}
          options={[{ value: "all", label: "All keys" }, { value: "live", label: "Live" }, { value: "test", label: "Test" }]} />
      </div>
      {error && <InlineError message={error} onRetry={load} />}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Panel className="space-y-4">
          <div className="flex items-start gap-3">
            <IconChip icon={BarChart3} />
            <div>
              <Eyebrow>Requests per day</Eyebrow>
              <p className="text-sm text-muted-foreground">
                {loading && !usage ? "Loading…" : `${t.total.toLocaleString()} requests, ${t.failed.toLocaleString()} failed${t.successRate === null ? "" : ` (${t.successRate}% succeeded)`}`}
              </p>
            </div>
          </div>
          {usage && <DayBars points={usage.daily} />}
        </Panel>

        <Panel className="space-y-3">
          <div className="flex items-start gap-3">
            <IconChip icon={TriangleAlert} tone="amber" />
            <div>
              <Eyebrow>Why requests failed</Eyebrow>
              <p className="text-sm text-muted-foreground">The most common reasons in this period.</p>
            </div>
          </div>
          {usage && usage.reasons.length === 0 && <p className="text-sm text-muted-foreground">No failures in this period.</p>}
          <ul className="divide-y divide-border">
            {(usage?.reasons ?? []).map((r) => (
              <li key={r.reason} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0">{reasonLabel(r.reason)}</span>
                <span className="shrink-0 font-semibold tabular-nums">{r.count.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Panel className="space-y-3">
          <div className="flex items-start gap-3">
            <IconChip icon={ListChecks} />
            <div>
              <Eyebrow>Endpoints</Eyebrow>
              <p className="text-sm text-muted-foreground">Requests per endpoint, busiest first.</p>
            </div>
          </div>
          {usage && usage.endpoints.length === 0 && <p className="text-sm text-muted-foreground">No requests in this period.</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-semibold">Endpoint</th>
                  <th className="py-2 pr-3 text-right font-semibold">Requests</th>
                  <th className="py-2 text-right font-semibold">Failed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(usage?.endpoints ?? []).map((e) => (
                  <tr key={e.endpoint}>
                    <td className="max-w-[16rem] truncate py-2 pr-3 font-mono text-xs">{e.endpoint}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{e.total.toLocaleString()}</td>
                    <td className={`py-2 text-right tabular-nums ${e.failed ? "text-rose-600 dark:text-rose-400" : ""}`}>{e.failed.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel className="space-y-3">
          <Eyebrow>Live orders by product</Eyebrow>
          {env === "test" ? (
            <p className="text-sm text-muted-foreground">Test purchases are not real orders, so they are not counted here.</p>
          ) : orders.length === 0 ? (
            <p className="text-sm text-muted-foreground">No live orders in this period.</p>
          ) : (
            <ul className="divide-y divide-border">
              {orders.map(([p, n]) => (
                <li key={p} className="flex items-center justify-between py-2 text-sm">
                  <span>{PRODUCT_LABEL[p as OrderProduct] ?? p}</span>
                  <span className="font-semibold tabular-nums">{Number(n).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  )
}
