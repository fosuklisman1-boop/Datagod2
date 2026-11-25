"use client"

import { useCallback, useEffect, useState } from "react"
import { Download, PackageSearch, RefreshCw, Search } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Eyebrow, IconChip, InlineError, Panel, TONE_CHIP } from "@/components/admin/api-keys/ui"
import { ghs, orderTone, shortTime } from "@/lib/api-v2/dev-dashboard-view"
import { ORDER_PRODUCTS, ORDER_STATUSES, PRODUCT_LABEL, type OrderProduct, type OrderRow } from "@/lib/api-v2/dev-dashboard"
import { cn } from "@/lib/utils"
import { dashDownload, dashJson } from "./dash-fetch"

const selectCls = "h-9 rounded-xl border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

interface Filters {
  q: string
  product: string
  status: string
  from: string
  to: string
}
const EMPTY: Filters = { q: "", product: "", status: "", from: "", to: "" }

function toParams(f: Filters, before: string | null): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(f)) if (v.trim()) p.set(k, v.trim())
  if (before) p.set("before", before)
  return p.toString()
}

function StatusPill({ status }: { status: string }) {
  return <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize", TONE_CHIP[orderTone(status)])}>{status}</span>
}

/** "Check status now": the same live lookup the order's GET endpoint runs. */
function CheckNow({ row, onStatus }: { row: OrderRow; onStatus: (s: string) => void }) {
  const [busy, setBusy] = useState(false)
  const check = async () => {
    setBusy(true)
    const r = await dashJson<{ order?: { status?: string } | null; claim?: { state?: string } | null }>(
      `/api/user/v2-dashboard/orders/${row.product}/${encodeURIComponent(row.reference)}`,
    )
    setBusy(false)
    if (!r.ok) return toast.error(r.error)
    const s = r.data.order?.status ?? (r.data.claim ? "processing" : null)
    if (s) {
      onStatus(s)
      toast.success(`${row.reference}: ${s}`)
    }
  }
  return (
    <Button size="sm" variant="ghost" className="h-8 px-2" disabled={busy} onClick={() => void check()} aria-label={`Check ${row.reference} now`}>
      <RefreshCw className={cn("size-3.5", busy && "animate-spin")} aria-hidden />
      <span className="ml-1">Check now</span>
    </Button>
  )
}

export function OrdersTab() {
  const [draft, setDraft] = useState<Filters>(EMPTY)
  const [applied, setApplied] = useState<Filters>(EMPTY)
  const [rows, setRows] = useState<OrderRow[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)

  const load = useCallback(
    async (before: string | null) => {
      setLoading(true)
      const r = await dashJson<{ rows: OrderRow[]; next: string | null }>(`/api/user/v2-dashboard/orders?${toParams(applied, before)}`)
      setLoading(false)
      if (!r.ok) return setError(r.error)
      setError(null)
      setRows((prev) => (before ? [...prev, ...r.data.rows] : r.data.rows))
      setNext(r.data.next)
    },
    [applied],
  )
  useEffect(() => void load(null), [load])

  const setStatus = (i: number, s: string) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, status: s } : r)))
  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft((d) => ({ ...d, [k]: e.target.value }))

  const download = async () => {
    setDownloading(true)
    const msg = await dashDownload(`/api/user/v2-dashboard/orders/csv?${toParams(applied, null)}`, "datagod-api-orders.csv")
    setDownloading(false)
    if (msg) toast(msg)
  }

  return (
    <Panel className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <IconChip icon={PackageSearch} />
        <div className="min-w-0 flex-1">
          <Eyebrow>Order finder</Eyebrow>
          <p className="text-sm text-muted-foreground">
            Your live API orders. Search by your reference (any date) or the recipient&apos;s number; otherwise up to 31 days at a time.
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={downloading} onClick={() => void download()}>
          <Download className="mr-1.5 size-4" aria-hidden /> {downloading ? "Preparing…" : "Download CSV"}
        </Button>
      </div>

      <form
        className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end"
        onSubmit={(e) => {
          e.preventDefault()
          setApplied(draft)
        }}
      >
        <label className="col-span-2 flex min-w-[14rem] flex-1 flex-col gap-1 text-xs font-semibold text-muted-foreground">
          Reference or phone number
          <Input value={draft.q} onChange={set("q")} placeholder="e.g. ORDER-1042 or 024 123 4567" className="h-9" maxLength={100} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
          Product
          <select className={selectCls} value={draft.product} onChange={set("product")}>
            <option value="">All products</option>
            {ORDER_PRODUCTS.map((p) => <option key={p} value={p}>{PRODUCT_LABEL[p]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
          Status
          <select className={selectCls} value={draft.status} onChange={set("status")}>
            <option value="">Any status</option>
            {ORDER_STATUSES.map((s) => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
          From
          <Input type="date" value={draft.from} onChange={set("from")} className="h-9" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
          To
          <Input type="date" value={draft.to} onChange={set("to")} className="h-9" />
        </label>
        <div className="col-span-2 flex gap-2 sm:col-span-1">
          <Button type="submit" size="sm" className="h-9"><Search className="mr-1.5 size-4" aria-hidden /> Search</Button>
          <Button type="button" size="sm" variant="ghost" className="h-9" onClick={() => { setDraft(EMPTY); setApplied(EMPTY) }}>Clear</Button>
        </div>
      </form>

      {error && <InlineError message={error} onRetry={() => void load(null)} />}
      {!loading && !error && rows.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No orders match.</p>}

      <ul className="space-y-2 md:hidden">
        {rows.map((r, i) => (
          <li key={`${r.product}:${r.reference}`} className="rounded-xl border border-border p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">{PRODUCT_LABEL[r.product as OrderProduct] ?? r.product}</span>
              <StatusPill status={r.status} />
            </div>
            <p className="mt-1 break-all font-mono text-xs">{r.reference}</p>
            <p className="mt-1 text-xs text-muted-foreground">{[r.item, r.recipient].filter(Boolean).join(" · ")}</p>
            <div className="mt-1 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{shortTime(r.created_at)} · {ghs(r.amount)}</span>
              <CheckNow row={r} onStatus={(s) => setStatus(i, s)} />
            </div>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-2 pr-3 font-semibold">Time (GMT)</th>
              <th className="py-2 pr-3 font-semibold">Product</th>
              <th className="py-2 pr-3 font-semibold">Reference</th>
              <th className="py-2 pr-3 font-semibold">Recipient</th>
              <th className="py-2 pr-3 font-semibold">Item</th>
              <th className="py-2 pr-3 text-right font-semibold">Amount</th>
              <th className="py-2 pr-3 font-semibold">Status</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r, i) => (
              <tr key={`${r.product}:${r.reference}`}>
                <td className="whitespace-nowrap py-2 pr-3 text-xs">{shortTime(r.created_at)}</td>
                <td className="py-2 pr-3 text-xs">{PRODUCT_LABEL[r.product as OrderProduct] ?? r.product}</td>
                <td className="max-w-[12rem] truncate py-2 pr-3 font-mono text-xs">{r.reference}</td>
                <td className="py-2 pr-3 text-xs">{r.recipient}</td>
                <td className="py-2 pr-3 text-xs">{r.item}</td>
                <td className="py-2 pr-3 text-right text-xs tabular-nums">{ghs(r.amount)}</td>
                <td className="py-2 pr-3"><StatusPill status={r.status} /></td>
                <td className="py-2 text-right"><CheckNow row={r} onStatus={(s) => setStatus(i, s)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {next && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(next)}>{loading ? "Loading…" : "Load more"}</Button>
        </div>
      )}
    </Panel>
  )
}
