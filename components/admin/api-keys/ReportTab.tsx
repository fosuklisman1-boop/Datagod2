"use client"

import { useCallback, useEffect, useState } from "react"
import { BarChart3, Download, Loader2 } from "lucide-react"
import type { ReportBy, ReportGroup } from "@/lib/api-v2/admin-console/report"
import { defaultRange, formatGhs, profitText, rangeToQuery, type MonthRange } from "@/lib/api-v2/admin-console/report-view"
import { adminDownload, adminFetch } from "./admin-fetch"
import { Eyebrow, IconChip, InlineError, Panel, Segmented } from "./ui"

export interface ReportData {
  groups: ReportGroup[]
  totals: ReportGroup | null
  other: { month: string; product: string; orders: number }[]
  otherCapped: boolean
}

const BY_LABEL: Record<ReportBy, string> = { developer: "Developer", product: "Product", month: "Month" }

function Profit({ g }: { g: ReportGroup }) {
  const p = profitText(g.profit)
  if (g.profit.kind === "none") return <span className="text-muted-foreground">{p.text}</span>
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="tabular-nums">{p.text}</span>
      {p.partial && <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] font-bold uppercase text-amber-700 dark:text-amber-300">partial</span>}
    </span>
  )
}

function SummaryCard({ label, value, note }: { label: string; value: React.ReactNode; note?: string }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-bold text-foreground">{value}</p>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  )
}

export function ReportTabView(p: {
  range: MonthRange
  by: ReportBy
  rangeError: string | null
  data: ReportData | null
  loading: boolean
  error: string | null
  exporting: boolean
  exportError: string | null
  onRange: (r: MonthRange) => void
  onBy: (b: ReportBy) => void
  onExport: () => void
  onRetry: () => void
}) {
  const d = p.data
  return (
    <Panel className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <IconChip icon={BarChart3} />
        <div className="min-w-0 flex-1">
          <Eyebrow>API v2</Eyebrow>
          <h2 className="text-base font-bold text-foreground">Business report</h2>
          <p className="text-sm text-muted-foreground">Data orders placed through API keys. Profit appears only where a supplier cost is set.</p>
        </div>
        <button
          type="button"
          onClick={p.onExport}
          disabled={p.exporting || !!p.rangeError}
          className="inline-flex h-9 items-center gap-2 rounded-xl border border-primary/40 px-3.5 text-sm font-semibold text-primary disabled:opacity-60"
        >
          {p.exporting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />}
          Export CSV
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-sm">
          <span className="block font-medium text-foreground">From</span>
          <input type="month" value={p.range.from} onChange={(e) => p.onRange({ ...p.range, from: e.target.value })} className="h-10 rounded-lg border border-border bg-background px-3 text-sm" />
        </label>
        <label className="space-y-1 text-sm">
          <span className="block font-medium text-foreground">To</span>
          <input type="month" value={p.range.to} onChange={(e) => p.onRange({ ...p.range, to: e.target.value })} className="h-10 rounded-lg border border-border bg-background px-3 text-sm" />
        </label>
        <Segmented<ReportBy>
          label="Group by"
          value={p.by}
          onChange={p.onBy}
          options={(Object.keys(BY_LABEL) as ReportBy[]).map((b) => ({ value: b, label: BY_LABEL[b] }))}
        />
      </div>

      {p.rangeError && <InlineError message={p.rangeError} />}
      {p.exportError && <InlineError message={`Export failed: ${p.exportError}`} />}

      {p.error ? (
        <InlineError message={p.error} onRetry={p.onRetry} />
      ) : !d ? (
        <div className="h-40 animate-pulse rounded-xl bg-muted" aria-label="Loading the report" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="min-w-0 space-y-4">
            {d.groups.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">No API orders in this range.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full min-w-[560px] text-left text-sm">
                  <thead className="bg-muted/50 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-semibold">{BY_LABEL[p.by]}</th>
                      <th className="px-3 py-2 text-right font-semibold">Orders</th>
                      <th className="px-3 py-2 text-right font-semibold">Revenue</th>
                      <th className="px-3 py-2 font-semibold">Profit</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {d.groups.map((g) => (
                      <tr key={g.key}>
                        <td className="max-w-[240px] break-words px-3 py-2 text-foreground">{g.label}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{g.orders.toLocaleString("en-GH")}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatGhs(g.revenue)}</td>
                        <td className="px-3 py-2"><Profit g={g} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <section className="space-y-2">
              <h3 className="text-sm font-bold text-foreground">Commission and other products</h3>
              <p className="text-xs text-muted-foreground">Completed purchases counted per month. Revenue is not tracked per order for these products.</p>
              {d.other.length === 0 ? (
                <p className="text-sm text-muted-foreground">None in this range.</p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-border">
                  <table className="w-full min-w-[360px] text-left text-sm">
                    <thead className="bg-muted/50 text-xs text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 font-semibold">Month</th>
                        <th className="px-3 py-2 font-semibold">Product</th>
                        <th className="px-3 py-2 text-right font-semibold">Purchases</th>
                        <th className="px-3 py-2 font-semibold">Revenue</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {d.other.map((o) => (
                        <tr key={`${o.month}-${o.product}`}>
                          <td className="px-3 py-2">{o.month}</td>
                          <td className="px-3 py-2">{o.product}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{o.orders.toLocaleString("en-GH")}</td>
                          <td className="px-3 py-2 text-muted-foreground">not tracked</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {d.otherCapped && <p className="text-xs text-amber-700 dark:text-amber-300">Only the first 20000 purchases were counted. Narrow the range for exact numbers.</p>}
            </section>
          </div>

          <aside className="grid content-start gap-3 sm:grid-cols-3 lg:grid-cols-1">
            <SummaryCard label="Data orders" value={(d.totals?.orders ?? 0).toLocaleString("en-GH")} />
            <SummaryCard label="Data revenue" value={formatGhs(d.totals?.revenue ?? 0)} />
            <SummaryCard
              label="Profit"
              value={d.totals ? <Profit g={d.totals} /> : "No cost set"}
              note={d.totals && d.totals.profit.kind !== "full" ? "Only orders with a supplier cost are counted." : undefined}
            />
          </aside>
        </div>
      )}
    </Panel>
  )
}

export function ReportTab() {
  const [range, setRange] = useState<MonthRange>(() => defaultRange(new Date()))
  const [by, setBy] = useState<ReportBy>("developer")
  const [data, setData] = useState<ReportData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const q = rangeToQuery(range, by, new Date())
  const query = q.ok ? q.query : null

  const load = useCallback(async () => {
    if (!query) return // the range message is shown; no request is sent
    setLoading(true)
    setError(null)
    const r = await adminFetch<ReportData>(`/api/admin/api-v2/report?${query}`)
    setData(r.ok ? r.data : null)
    setError(r.ok ? null : r.error)
    setLoading(false)
  }, [query])

  useEffect(() => {
    void load()
  }, [load])

  const onExport = async () => {
    if (!query || exporting) return
    setExporting(true)
    setExportError(null)
    const r = await adminDownload(`/api/admin/api-v2/report?${query}&format=csv`, `api-report-${range.from}-to-${range.to}.csv`)
    setExporting(false)
    if (!r.ok) setExportError(r.error)
  }

  return (
    <ReportTabView
      range={range}
      by={by}
      rangeError={q.ok ? null : q.error}
      data={data}
      loading={loading}
      error={error}
      exporting={exporting}
      exportError={exportError}
      onRange={setRange}
      onBy={setBy}
      onExport={() => void onExport()}
      onRetry={() => void load()}
    />
  )
}
