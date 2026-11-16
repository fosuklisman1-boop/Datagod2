"use client"

import { useState } from "react"
import { Search } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ADMIN_STATUSES, STATUS_LABELS, flagReasonsText, formatGhs, rowActions, type RowAction } from "@/lib/momo-claim/admin-view"
import type { ListResponse, Tx } from "./api"
import { ActionDialog } from "./ActionDialog"
import { RawSmsDialog } from "./RawSmsDialog"

export type Filters = { status: string; network: string; q: string; from: string; to: string }
export const EMPTY_FILTERS: Filters = { status: "", network: "", q: "", from: "", to: "" }

const selectCls = "h-9 rounded-md border bg-background px-2 text-sm"

function statusTone(status: string): string {
  switch (status) {
    case "claimed":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
    case "flagged":
      return "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300"
    case "pending":
      return "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300"
    case "voided":
    case "rejected_sender":
      return "bg-muted text-muted-foreground"
    default:
      return "bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-300"
  }
}

export function MonitoringTab({
  data,
  loading,
  error,
  filters,
  onApply,
  onChanged,
}: {
  data: ListResponse | null
  loading: boolean
  error: string | null
  filters: Filters
  onApply: (f: Filters) => void
  onChanged: (message: string) => void
}) {
  const [draft, setDraft] = useState<Filters>(filters)
  const [action, setAction] = useState<{ tx: Tx; action: RowAction } | null>(null)
  const [rawTx, setRawTx] = useState<string | null>(null)
  const set = (k: keyof Filters) => (v: string) => setDraft((d) => ({ ...d, [k]: v }))

  return (
    <div className="space-y-4">
      {data && data.suspicious.length > 0 && (
        <Card className="border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-red-700 dark:text-red-300">Suspicious users</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p className="mb-2 text-xs text-muted-foreground">Users with many wrong payment-code attempts.</p>
            <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
              {data.suspicious.map((s) => (
                <li key={s.userId} className="flex items-center justify-between gap-2 rounded border bg-background px-2 py-1">
                  <span className="truncate font-mono text-xs">{s.userId}</span>
                  <Badge variant="destructive">{s.attempts}</Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {ADMIN_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onApply({ ...draft, status: filters.status === s ? "" : s })}
            className={`rounded-lg border p-3 text-left transition-colors hover:bg-muted/60 ${filters.status === s ? "border-primary ring-1 ring-primary" : ""}`}
          >
            <div className="text-xs text-muted-foreground">{STATUS_LABELS[s]}</div>
            <div className="text-2xl font-semibold tabular-nums">{data?.counts?.[s] ?? 0}</div>
          </button>
        ))}
      </div>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          onApply(draft)
        }}
      >
        <div className="min-w-[10rem] flex-1 lg:max-w-xs">
          <label className="text-xs text-muted-foreground" htmlFor="mc-q">Search ID or name</label>
          <Input id="mc-q" value={draft.q} onChange={(e) => set("q")(e.target.value)} placeholder="Transaction ID, sender or user ID" />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground" htmlFor="mc-status">Status</label>
          <select id="mc-status" className={selectCls} value={draft.status} onChange={(e) => set("status")(e.target.value)}>
            <option value="">All</option>
            {ADMIN_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-muted-foreground" htmlFor="mc-net">Network</label>
          <select id="mc-net" className={selectCls} value={draft.network} onChange={(e) => set("network")(e.target.value)}>
            <option value="">All</option>
            <option value="MTN">MTN</option>
            <option value="Telecel">Telecel</option>
            <option value="AirtelTigo">AirtelTigo</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-muted-foreground" htmlFor="mc-from">From</label>
          <Input id="mc-from" type="date" value={draft.from} onChange={(e) => set("from")(e.target.value)} />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground" htmlFor="mc-to">To</label>
          <Input id="mc-to" type="date" value={draft.to} onChange={(e) => set("to")(e.target.value)} />
        </div>
        <Button type="submit" disabled={loading}><Search className="mr-1 h-4 w-4" />Apply</Button>
        <Button type="button" variant="outline" onClick={() => { setDraft(EMPTY_FILTERS); onApply(EMPTY_FILTERS) }}>Clear</Button>
      </form>

      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Transaction ID</TableHead>
              <TableHead>Network</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">Fee</TableHead>
              <TableHead className="text-right">Net</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Flags</TableHead>
              <TableHead>Claimed by</TableHead>
              <TableHead>Received</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.transactions.length === 0 && (
              <TableRow><TableCell colSpan={10} className="py-8 text-center text-muted-foreground">{loading ? "Loading..." : "No transactions match."}</TableCell></TableRow>
            )}
            {data?.transactions.map((tx) => {
              const actions = rowActions(tx.status, tx.flag_reasons)
              const reviewHint = actions.find((a) => a.hint)?.hint
              return (
                <TableRow key={tx.id}>
                  <TableCell className="font-mono text-xs">{tx.transaction_id}</TableCell>
                  <TableCell>{tx.network ?? "-"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatGhs(tx.amount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatGhs(tx.fee)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatGhs(tx.net_amount)}</TableCell>
                  <TableCell><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusTone(tx.status)}`}>{STATUS_LABELS[tx.status] ?? tx.status}</span></TableCell>
                  <TableCell className="max-w-[14rem] text-xs">{flagReasonsText(tx.flag_reasons) || "-"}</TableCell>
                  <TableCell className="max-w-[8rem] truncate font-mono text-xs" title={tx.claimed_by ?? undefined}>{tx.claimed_by ?? "-"}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{new Date(tx.received_at).toLocaleString()}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setRawTx(tx.transaction_id)}>View SMS</Button>
                      {actions.map((a) => (
                        <Button key={a.action} size="sm" variant={a.primary ? "default" : "outline"} onClick={() => setAction({ tx, action: a.action })}>{a.label}</Button>
                      ))}
                    </div>
                    {reviewHint && <p className="mt-1 max-w-[16rem] text-[11px] text-muted-foreground">{reviewHint}</p>}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">Showing the latest 200 matching rows.</p>

      <ActionDialog target={action} onClose={() => setAction(null)} onDone={(m) => { setAction(null); onChanged(m) }} />
      <RawSmsDialog txid={rawTx} onClose={() => setRawTx(null)} />
    </div>
  )
}
