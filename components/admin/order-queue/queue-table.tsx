"use client"

import type { ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"
import { formatAge } from "@/lib/order-queue/export"
import { FAILURE_REASON_LABELS } from "@/lib/order-queue/failure-reason"
import { allSuppliers } from "@/lib/order-queue/supplier-capability"
import type { OrderType, QueueRow } from "@/lib/order-queue/types"
import { ORDER_TYPE_LABELS } from "./filter-panel"

const SUPPLIER_LABELS = new Map(allSuppliers().map((s) => [s.value, s.label]))
export const supplierLabel = (v: string) => SUPPLIER_LABELS.get(v) ?? v

function networkClass(network: string | null): string {
  const map: Record<string, string> = {
    MTN: "bg-yellow-100 text-yellow-800",
    Telecel: "bg-primary/10 text-primary",
    "AT - iShare": "bg-primary/10 text-primary",
    "AT - BigTime": "bg-green-100 text-green-800",
    iShare: "bg-primary/10 text-primary",
  }
  return map[network ?? ""] || "bg-muted text-foreground"
}

function statusClass(status: string | null): string {
  switch (status) {
    case "completed":
      return "bg-success/15 text-success border-border"
    case "pending":
      return "bg-warning/15 text-warning border-border"
    case "processing":
      return "bg-primary/10 text-primary border-primary/20"
    case "failed":
    case "reversed":
      return "bg-destructive/15 text-destructive border-border"
    default:
      return "bg-muted text-foreground border-border"
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export type QueueTableProps = {
  rows: QueueRow[]
  selectedIds: ReadonlySet<string>
  /** "Select all N matching" is on: every row reads as selected. */
  allMatching: boolean
  onToggle: (id: string) => void
  /** Header checkbox: select (or clear) the loaded rows. */
  onTogglePage: (select: boolean) => void
  /** Per-row actions (status change, single fulfil) rendered by the page. */
  renderActions?: (row: QueueRow) => ReactNode
  /** Clock for the age column (injectable for tests). */
  now?: number
}

export function QueueTable({ rows, selectedIds, allMatching, onToggle, onTogglePage, renderActions, now }: QueueTableProps) {
  const clock = now ?? Date.now()
  const isSelected = (id: string) => allMatching || selectedIds.has(id)
  const selectedOnPage = rows.filter((r) => isSelected(r.id)).length
  const headerState: boolean | "indeterminate" =
    rows.length > 0 && selectedOnPage === rows.length ? true : selectedOnPage > 0 ? "indeterminate" : false

  const th = "px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground whitespace-nowrap"
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b bg-muted/40">
          <tr>
            <th className="w-10 px-3 py-2">
              <Checkbox
                aria-label="Select loaded orders"
                checked={headerState}
                onCheckedChange={() => onTogglePage(headerState !== true)}
              />
            </th>
            <th className={th}>Order</th>
            <th className={th}>Type</th>
            <th className={th}>Network</th>
            <th className={th}>Size</th>
            <th className={cn(th, "text-right")}>Price</th>
            <th className={th}>Status</th>
            <th className={th}>Last supplier</th>
            <th className={cn(th, "text-center")}>Attempts</th>
            <th className={th}>Age</th>
            {renderActions && <th className={th}>Actions</th>}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => {
            const selected = isSelected(r.id)
            const reason = r.failureReason && r.failureReason !== "none" ? FAILURE_REASON_LABELS[r.failureReason] : null
            return (
              <tr key={r.id} data-row-id={r.id} className={cn("align-top hover:bg-accent/50", selected && "bg-primary/5")}>
                <td className="px-3 py-3">
                  <Checkbox aria-label={`Select order ${r.id.slice(0, 8)}`} checked={selected} onCheckedChange={() => onToggle(r.id)} />
                </td>
                <td className="px-3 py-3">
                  <div className="font-mono text-xs font-semibold" title={r.id}>
                    {r.id.slice(0, 8)}
                  </div>
                  {r.phoneNumber && <div className="font-mono text-xs text-muted-foreground">{r.phoneNumber}</div>}
                  {r.paymentReference && (
                    <div className="max-w-[10rem] truncate font-mono text-[11px] text-muted-foreground" title={r.paymentReference}>
                      {r.paymentReference}
                    </div>
                  )}
                </td>
                <td className="px-3 py-3">
                  <Badge variant="outline" className="text-xs">
                    {r.type ? ORDER_TYPE_LABELS[r.type as OrderType] ?? r.type : "—"}
                  </Badge>
                </td>
                <td className="px-3 py-3">
                  <Badge className={cn("whitespace-nowrap border", networkClass(r.network))}>{r.network ?? "—"}</Badge>
                </td>
                <td className="whitespace-nowrap px-3 py-3">{r.volumeGb ? `${r.volumeGb}GB` : "—"}</td>
                <td className="whitespace-nowrap px-3 py-3 text-right font-semibold">₵ {(r.price ?? 0).toFixed(2)}</td>
                <td className="px-3 py-3">
                  <div className="flex flex-wrap gap-1">
                    <Badge className={cn("border text-xs", statusClass(r.status))}>{r.status ? cap(r.status) : "Unknown"}</Badge>
                    {r.isHeld && (
                      <Badge variant="outline" className="border-warning/40 text-xs text-warning" data-flag="held">
                        Held
                      </Badge>
                    )}
                    {r.hasReversal && r.status !== "reversed" && (
                      <Badge variant="outline" className="text-xs text-destructive" data-flag="reversal">
                        Reversed before
                      </Badge>
                    )}
                  </div>
                </td>
                <td className="px-3 py-3" data-col="last-supplier">
                  {r.lastProvider ? (
                    <>
                      <div className="whitespace-nowrap font-medium">
                        {supplierLabel(r.lastProvider)}
                        {r.lastAttemptStatus && (
                          <span className="ml-1 text-xs font-normal text-muted-foreground">· {r.lastAttemptStatus}</span>
                        )}
                      </div>
                      {reason && <div className="text-xs text-destructive">{reason}</div>}
                      {r.lastError && (
                        <div className="max-w-[14rem] truncate text-xs text-muted-foreground" title={r.lastError}>
                          {r.lastError}
                        </div>
                      )}
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">Not sent yet</span>
                  )}
                </td>
                <td className="px-3 py-3 text-center tabular-nums" data-col="attempts">
                  {r.attemptCount}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground" title={new Date(r.createdAt).toLocaleString()}>
                  {formatAge(r.createdAt, clock)}
                </td>
                {renderActions && <td className="px-3 py-3">{renderActions(r)}</td>}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
