"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Store } from "lucide-react"
import { DRAWER_PAGE_SIZE } from "@/lib/admin-users/drawer-params"
import { userApiPath } from "@/lib/admin-users/drawer-client"
import { LoadState, Pager, StatusBadge, dateOnly, ghs, useAdminGet } from "./shared"
import type { Paged, ShopResponse, SubAgentRow, WithdrawalRow } from "./types"

/** Shop summary, sub-agents (each opens in the drawer), parent shop, and withdrawals. */
export function ShopTab({ userId, onOpenUser, refreshKey = 0 }: { userId: string; onOpenUser: (userId: string) => void; refreshKey?: number }) {
  const [subPage, setSubPage] = useState(1)
  const [wdPage, setWdPage] = useState(1)
  const summary = useAdminGet<ShopResponse>(userApiPath(userId, "shop"), refreshKey)
  // Pages after the first come from the list-only form of the route.
  const subs = useAdminGet<{ subAgents: Paged<SubAgentRow> }>(
    subPage > 1 ? userApiPath(userId, "shop", { part: "sub_agents", page: subPage, pageSize: DRAWER_PAGE_SIZE }) : null,
  )
  const wds = useAdminGet<{ withdrawals: Paged<WithdrawalRow> }>(
    wdPage > 1 ? userApiPath(userId, "shop", { part: "withdrawals", page: wdPage, pageSize: DRAWER_PAGE_SIZE }) : null,
  )
  const d = summary.data
  const subList = subPage > 1 ? subs.data?.subAgents : d?.subAgents
  const wdList = wdPage > 1 ? wds.data?.withdrawals : d?.withdrawals
  const origin = typeof window !== "undefined" ? window.location.origin : ""

  return (
    <LoadState loading={summary.loading && !d} error={summary.error} onRetry={summary.reload}>
      {d && (
        <div className="space-y-4">
          {d.shop ? (
            <>
              <div className="p-3 bg-primary/10 rounded-lg border border-border space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold text-primary">{d.shop.shop_name}</p>
                  {d.shop.is_active === false && <StatusBadge status="inactive" />}
                </div>
                <a className="text-xs text-primary underline break-all" href={`${origin}/shop/${d.shop.shop_slug}`} target="_blank" rel="noreferrer">
                  {origin}/shop/{d.shop.shop_slug}
                </a>
                <p className="text-xs text-muted-foreground">Created {dateOnly(d.shop.created_at)} · {d.shop.customers.toLocaleString()} customers</p>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {([
                  ["Available", d.shop.balance.available],
                  ["Total profit", d.shop.balance.totalProfit],
                  ["Credited", d.shop.balance.credited],
                  ["Pending", d.shop.balance.pending],
                  ["Withdrawn", d.shop.balance.withdrawn],
                ] as const).map(([label, v]) => (
                  <Card key={label} className="border-border"><CardContent className="p-3">
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="font-bold">{ghs(v)}</p>
                  </CardContent></Card>
                ))}
              </div>
            </>
          ) : (
            <div className="text-center py-6 text-muted-foreground">
              <Store className="w-10 h-10 mx-auto mb-2" />
              <p>This user does not own a shop</p>
            </div>
          )}

          {d.parent && (
            <div className="text-sm p-3 border rounded-lg flex items-center justify-between gap-2">
              <span>Sub-agent of <strong>{d.parent.shop_name}</strong> <span className="text-xs text-muted-foreground">/{d.parent.shop_slug}</span></span>
              <Button size="sm" variant="outline" onClick={() => onOpenUser(d.parent!.user_id)}>Open owner</Button>
            </div>
          )}

          {d.shop && (
            <section className="space-y-2">
              <h4 className="text-sm font-semibold">Sub-agents ({(subList?.total ?? 0).toLocaleString()})</h4>
              <LoadState loading={subs.loading && !subList} error={subs.error} onRetry={subs.reload}
                empty={subList && subList.rows.length === 0 ? "No sub-agents" : undefined}>
                <ul className="divide-y border rounded-lg">
                  {subList?.rows.map((s) => (
                    <li key={s.shop_id} className="px-3 py-2 flex items-center justify-between gap-2 text-sm">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{s.shop_name}</p>
                        <p className="text-xs text-muted-foreground truncate">{s.email ?? s.user_id} · joined {dateOnly(s.created_at)}</p>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => onOpenUser(s.user_id)}>Open</Button>
                    </li>
                  ))}
                </ul>
                {subList && <Pager page={subList.page} pageSize={subList.pageSize} total={subList.total} loading={subs.loading} onPage={setSubPage} />}
              </LoadState>
            </section>
          )}

          <section className="space-y-2">
            <h4 className="text-sm font-semibold">Withdrawals ({(wdList?.total ?? 0).toLocaleString()})</h4>
            <LoadState loading={wds.loading && !wdList} error={wds.error} onRetry={wds.reload}
              empty={wdList && wdList.rows.length === 0 ? "No withdrawals" : undefined}>
              <div className="border rounded-lg overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-xs">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Date</th>
                      <th className="px-3 py-2 text-left font-medium">Net amount</th>
                      <th className="px-3 py-2 text-left font-medium">Method</th>
                      <th className="px-3 py-2 text-left font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {wdList?.rows.map((w) => (
                      <tr key={w.id}>
                        <td className="px-3 py-2 text-xs whitespace-nowrap">{dateOnly(w.created_at)}</td>
                        <td className="px-3 py-2 font-medium" title={`Requested ${ghs(w.amount)}, fee ${ghs(w.fee_amount)}`}>{ghs(w.net_amount ?? w.amount)}</td>
                        <td className="px-3 py-2 text-xs capitalize">{(w.withdrawal_method ?? "—").replace(/_/g, " ")}</td>
                        <td className="px-3 py-2"><StatusBadge status={w.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {wdList && <Pager page={wdList.page} pageSize={wdList.pageSize} total={wdList.total} loading={wds.loading} onPage={setWdPage} />}
            </LoadState>
          </section>
        </div>
      )}
    </LoadState>
  )
}
