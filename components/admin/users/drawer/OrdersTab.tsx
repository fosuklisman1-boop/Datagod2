"use client"

import { useState } from "react"
import { ORDER_SOURCES, ORDER_SOURCE_LABELS, ORDER_STATUSES, DRAWER_PAGE_SIZE, type OrderSource, type OrderStatus } from "@/lib/admin-users/drawer-params"
import { userApiPath } from "@/lib/admin-users/drawer-client"
import { LoadState, Pager, StatusBadge, dateTime, ghs, useAdminGet } from "./shared"
import type { OrdersResponse } from "./types"

const selectClass = "px-2 py-1.5 border border-border rounded-md bg-background text-sm"

/** The user's orders across every order table, newest first, 20 per page. */
export function OrdersTab({ userId }: { userId: string }) {
  const [page, setPage] = useState(1)
  const [source, setSource] = useState<OrderSource | "">("")
  const [status, setStatus] = useState<OrderStatus | "">("")
  const { data, error, loading, reload } = useAdminGet<OrdersResponse>(
    userApiPath(userId, "orders", { page, pageSize: DRAWER_PAGE_SIZE, source, status }),
  )
  const allCount = data ? Object.values(data.counts).reduce<number>((a, b) => a + Number(b ?? 0), 0) : null

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <select aria-label="Order type" className={selectClass} value={source}
          onChange={(e) => { setSource(e.target.value as OrderSource | ""); setPage(1) }}>
          <option value="">All types{allCount !== null ? ` (${allCount})` : ""}</option>
          {ORDER_SOURCES.map((s) => (
            <option key={s} value={s}>{ORDER_SOURCE_LABELS[s]}{data ? ` (${data.counts[s] ?? 0})` : ""}</option>
          ))}
        </select>
        <select aria-label="Order status" className={selectClass} value={status}
          onChange={(e) => { setStatus(e.target.value as OrderStatus | ""); setPage(1) }}>
          <option value="">Any status</option>
          {ORDER_STATUSES.map((s) => <option key={s} value={s} className="capitalize">{s}</option>)}
        </select>
      </div>
      <LoadState loading={loading && !data} error={error} onRetry={reload}
        empty={data && data.rows.length === 0 ? "No orders match" : undefined}>
        <div className={`border rounded-lg overflow-x-auto ${loading ? "opacity-60" : ""}`}>
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Date</th>
                <th className="px-3 py-2 text-left font-medium">Order</th>
                <th className="px-3 py-2 text-left font-medium">Amount</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data?.rows.map((o) => (
                <tr key={`${o.source}:${o.id}`}>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">{dateTime(o.created_at)}</td>
                  <td className="px-3 py-2">
                    <p className="font-medium">{o.description || "—"}</p>
                    <p className="text-xs text-muted-foreground">
                      {ORDER_SOURCE_LABELS[o.source] ?? o.source}
                      {o.recipient ? ` · ${o.recipient}` : ""}
                      {o.reference ? ` · ${o.reference}` : ""}
                    </p>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{ghs(o.amount)}</td>
                  <td className="px-3 py-2"><StatusBadge status={o.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} loading={loading} onPage={setPage} />}
      </LoadState>
    </div>
  )
}
