"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { DRAWER_PAGE_SIZE, TX_FILTERS, type TxFilter } from "@/lib/admin-users/drawer-params"
import { userApiPath } from "@/lib/admin-users/drawer-client"
import { DuplicateWalletWarning, LoadState, Pager, StatusBadge, dateTime, ghs, useAdminGet } from "./shared"
import type { TxResponse } from "./types"

const TX_FILTER_LABELS: Record<TxFilter, string> = {
  credit: "Credits", debit: "Debits", refund: "Refunds", admin: "Admin adjustments", clawback: "Refund clawbacks",
}
const CREDIT_TYPES = new Set(["credit", "refund", "admin_credit", "refund_clawback_undo"])

/** Current wallet balance and the transactions ledger, newest first, 20 per page. */
export function WalletTab({ userId, onAdjust, refreshKey = 0 }: { userId: string; onAdjust: (balance: number) => void; refreshKey?: number }) {
  const [page, setPage] = useState(1)
  const [type, setType] = useState<TxFilter | "">("")
  const { data, error, loading, reload } = useAdminGet<TxResponse>(
    userApiPath(userId, "transactions", { page, pageSize: DRAWER_PAGE_SIZE, type }),
    refreshKey,
  )

  return (
    <div className="space-y-3">
      {data?.wallet && <DuplicateWalletWarning rows={data.wallet.rows} />}
      <div className="grid grid-cols-3 gap-2">
        <Card className="bg-primary/5 border-primary/20"><CardContent className="p-3">
          <p className="text-xs text-primary font-medium">Balance</p>
          <p className="text-lg font-bold text-primary">{data ? (data.wallet ? ghs(data.wallet.balance) : "No wallet") : "…"}</p>
        </CardContent></Card>
        <Card className="bg-success/10 border-border"><CardContent className="p-3">
          <p className="text-xs text-success font-medium">Total credited</p>
          <p className="text-lg font-bold text-success">{data?.wallet ? ghs(data.wallet.totalCredited) : "…"}</p>
        </CardContent></Card>
        <Card className="bg-warning/10 border-border"><CardContent className="p-3">
          <p className="text-xs text-warning font-medium">Total spent</p>
          <p className="text-lg font-bold text-warning">{data?.wallet ? ghs(data.wallet.totalSpent) : "…"}</p>
        </CardContent></Card>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <select aria-label="Transaction type" className="px-2 py-1.5 border border-border rounded-md bg-background text-sm" value={type}
          onChange={(e) => { setType(e.target.value as TxFilter | ""); setPage(1) }}>
          <option value="">All transactions</option>
          {(Object.keys(TX_FILTERS) as TxFilter[]).map((t) => <option key={t} value={t}>{TX_FILTER_LABELS[t]}</option>)}
        </select>
        <Button size="sm" disabled={!data?.wallet || data.wallet.rows > 1} onClick={() => data?.wallet && onAdjust(data.wallet.balance)}>
          Adjust wallet
        </Button>
      </div>
      <LoadState loading={loading && !data} error={error} onRetry={reload}
        empty={data && data.rows.length === 0 ? "No transactions" : undefined}>
        <div className={`border rounded-lg overflow-x-auto ${loading ? "opacity-60" : ""}`}>
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Date</th>
                <th className="px-3 py-2 text-left font-medium">Transaction</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 text-right font-medium">Before → after</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data?.rows.map((t) => {
                const credit = CREDIT_TYPES.has(t.type)
                return (
                  <tr key={t.id}>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">{dateTime(t.created_at)}</td>
                    <td className="px-3 py-2">
                      <p className="font-medium">{t.description || t.type}</p>
                      <p className="text-xs text-muted-foreground flex items-center gap-1 flex-wrap">
                        <span>{t.type}</span>{t.source ? <span>· {t.source}</span> : null}
                        {t.reference_id ? <span className="break-all">· {t.reference_id}</span> : null}
                        {t.status && t.status !== "completed" ? <StatusBadge status={t.status} /> : null}
                      </p>
                    </td>
                    <td className={`px-3 py-2 text-right whitespace-nowrap font-medium ${credit ? "text-success" : "text-destructive"}`}>
                      {credit ? "+" : "−"}{ghs(Math.abs(Number(t.amount)))}
                    </td>
                    <td className="px-3 py-2 text-right text-xs whitespace-nowrap text-muted-foreground">
                      {t.balance_before == null && t.balance_after == null ? "—" : `${ghs(t.balance_before)} → ${ghs(t.balance_after)}`}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} loading={loading} onPage={setPage} />}
      </LoadState>
    </div>
  )
}
