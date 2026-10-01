"use client"

import { useState, useEffect, useCallback } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { DashboardHeroBanner } from "@/components/shared/dashboard-hero-banner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Search,
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Zap,
} from "lucide-react"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"
import { shopService } from "@/lib/shop-service"
import { useAuth } from "@/lib/auth-context"

const formatCurrency = (n: number | null | undefined) =>
  n == null ? "GHS 0.00" : `GHS ${n.toFixed(2)}`

const formatAge = (createdAt: string) => {
  const diffMs = Date.now() - new Date(createdAt).getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

interface PendingOrder {
  id: string
  reference_code: string
  wallet_reference: string
  customer_phone: string
  customer_name?: string
  network: string
  total_price: number
  payment_status: string
  order_status: string
  created_at: string
}

interface ReverifyResult {
  paystack_status: string
  action: string
  fulfillment?: string
}

export default function ShopPaymentReverifyPage() {
  const { user } = useAuth()
  const [shopId, setShopId] = useState<string | null>(null)
  const [shopLoading, setShopLoading] = useState(true)

  const [orders, setOrders] = useState<PendingOrder[]>([])
  const [loading, setLoading] = useState(false)
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set())
  const [rowResults, setRowResults] = useState<Record<string, ReverifyResult>>({})
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [totalCount, setTotalCount] = useState(0)
  const limit = 20

  // Resolve shop on mount
  useEffect(() => {
    if (!user?.id) return
    shopService.getShop(user.id)
      .then((shop) => setShopId(shop?.id ?? null))
      .catch(() => setShopId(null))
      .finally(() => setShopLoading(false))
  }, [user?.id])

  const getAuthHeader = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) throw new Error("Not authenticated")
    return `Bearer ${session.access_token}`
  }, [])

  const fetchOrders = useCallback(async () => {
    if (!shopId) return
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: page.toString(), limit: limit.toString() })
      if (search) params.append("search", search)

      const auth = await getAuthHeader()
      const res = await fetch(`/api/shop/payment-reverify?${params}`, {
        headers: { Authorization: auth },
      })
      if (!res.ok) throw new Error("Failed to fetch orders")
      const data = await res.json()

      setOrders(data.orders || [])
      setTotalPages(data.pagination?.totalPages || 1)
      setTotalCount(data.pagination?.totalCount || 0)
      setRowResults({})
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load pending orders")
    } finally {
      setLoading(false)
    }
  }, [shopId, page, search, getAuthHeader])

  useEffect(() => {
    if (shopId) fetchOrders()
  }, [fetchOrders, shopId])

  useEffect(() => {
    setPage(1)
  }, [search])

  const reverifyOrder = async (order: PendingOrder) => {
    setProcessingIds((prev) => new Set(prev).add(order.id))
    try {
      const auth = await getAuthHeader()
      const res = await fetch("/api/shop/payment-reverify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({ orderId: order.id }),
      })
      const data: ReverifyResult = await res.json()
      if (!res.ok) throw new Error((data as any).error || "Reverify failed")

      setRowResults((prev) => ({ ...prev, [order.id]: data }))

      if (data.paystack_status === "success" && data.action !== "already_processed") {
        toast.success(`${order.reference_code} — verified & processed`)
      } else if (data.action === "already_processed") {
        toast.info(`${order.reference_code} — already processed`)
      } else if (data.paystack_status === "pending") {
        toast.warning(`${order.reference_code} — still pending on Paystack`)
      } else {
        toast.error(`${order.reference_code} — ${data.paystack_status}`)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reverify failed")
    } finally {
      setProcessingIds((prev) => {
        const next = new Set(prev)
        next.delete(order.id)
        return next
      })
    }
  }

  const getResultBadge = (result: ReverifyResult) => {
    switch (result.paystack_status) {
      case "success":
        return result.action === "already_processed"
          ? <Badge className="bg-[#1b388b] text-xs">Already Done</Badge>
          : <Badge className="bg-success text-xs"><CheckCircle className="w-3 h-3 mr-1" />Verified</Badge>
      case "failed":
        return <Badge className="bg-destructive text-xs"><XCircle className="w-3 h-3 mr-1" />Failed</Badge>
      case "abandoned":
        return <Badge className="bg-muted-foreground text-xs"><AlertTriangle className="w-3 h-3 mr-1" />Abandoned</Badge>
      case "pending":
        return <Badge className="bg-amber-500 text-xs"><Clock className="w-3 h-3 mr-1" />Still Pending</Badge>
      default:
        return <Badge variant="secondary" className="text-xs">{result.paystack_status}</Badge>
    }
  }

  if (shopLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="w-8 h-8 animate-spin text-[#1b388b]" />
        </div>
      </DashboardLayout>
    )
  }

  if (!shopId) {
    return (
      <DashboardLayout>
        <div className="mx-auto max-w-2xl lg:max-w-4xl">
          <p className="text-muted-foreground">You don't have a shop set up yet.</p>
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-2xl lg:max-w-4xl space-y-5">
        <DashboardHeroBanner title="Payment Reverification" subtitle="Check pending customer orders against Paystack and trigger fulfillment" icon={Zap}>
          <Button variant="outline" size="sm" className="rounded-full border-white/25 bg-white/10 text-white hover:bg-white/20 hover:text-white" onClick={fetchOrders} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </DashboardHeroBanner>

        {/* Search */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              placeholder="Search by reference, phone or name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-2xl border border-border bg-card py-2.5 pl-10 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-[#1b388b]/30"
            />
          </div>
          {search && (
            <button
              onClick={() => setSearch("")}
              className="shrink-0 rounded-2xl border border-border px-4 text-sm font-semibold text-foreground hover:bg-accent"
            >
              Clear
            </button>
          )}
        </div>

        {/* Orders */}
        {loading ? (
          <div className="rounded-2xl border border-border bg-card py-12 text-center">
            <Loader2 className="mx-auto h-6 w-6 animate-spin text-[#1b388b]" />
          </div>
        ) : orders.length === 0 ? (
          <div className="rounded-2xl border border-border bg-card py-12 text-center">
            <CheckCircle className="mx-auto mb-2 h-8 w-8 text-success" />
            <p className="text-sm text-muted-foreground">No pending orders</p>
          </div>
        ) : (
          <>
            {/* Mobile: stacked cards */}
            <div className="space-y-2 lg:hidden">
              {orders.map((order) => {
                const isProcessing = processingIds.has(order.id)
                const result = rowResults[order.id]
                return (
                  <div
                    key={order.id}
                    className={`rounded-2xl border p-4 ${result?.paystack_status === "success" && result.action !== "already_processed" ? "border-success/30 bg-success/5" : "border-border bg-card"}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-mono text-xs font-semibold text-foreground">{order.wallet_reference}</p>
                        <p className="truncate font-mono text-xs text-muted-foreground">{order.reference_code}</p>
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatAge(order.created_at)}</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{order.customer_name || "—"}</p>
                        <p className="text-xs text-muted-foreground">{order.customer_phone} · {order.network}</p>
                      </div>
                      <p className="shrink-0 text-sm font-semibold text-foreground">{formatCurrency(order.total_price)}</p>
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        {result ? getResultBadge(result) : <span className="text-xs text-muted-foreground">—</span>}
                        {result?.fulfillment && result.fulfillment !== "skipped (tracking exists)" && (
                          <p className="mt-0.5 text-xs text-muted-foreground">Fulfillment: {result.fulfillment}</p>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant={result ? "outline" : "default"}
                        onClick={() => reverifyOrder(order)}
                        disabled={isProcessing}
                        className={`shrink-0 text-xs ${!result ? "bg-[#1b388b] hover:bg-[#1b388b]/90 text-white" : ""}`}
                      >
                        {isProcessing ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <><Zap className="w-3 h-3 mr-1" />{result ? "Re-check" : "Reverify"}</>
                        )}
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Desktop: table */}
            <div className="hidden overflow-hidden rounded-2xl border border-border lg:block">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold">Reference</th>
                    <th className="px-4 py-3 text-left font-semibold">Customer</th>
                    <th className="px-4 py-3 text-left font-semibold">Network</th>
                    <th className="px-4 py-3 text-left font-semibold">Amount</th>
                    <th className="px-4 py-3 text-left font-semibold">Age</th>
                    <th className="px-4 py-3 text-left font-semibold">Result</th>
                    <th className="px-4 py-3 text-right font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {orders.map((order) => {
                    const isProcessing = processingIds.has(order.id)
                    const result = rowResults[order.id]
                    return (
                      <tr
                        key={order.id}
                        className={result?.paystack_status === "success" && result.action !== "already_processed" ? "bg-success/10" : undefined}
                      >
                        <td className="px-4 py-3">
                          <p className="font-mono text-xs text-foreground">{order.wallet_reference}</p>
                          <p className="font-mono text-xs text-muted-foreground">{order.reference_code}</p>
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-sm font-medium text-foreground">{order.customer_name || "—"}</p>
                          <p className="text-xs text-muted-foreground">{order.customer_phone}</p>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{order.network}</td>
                        <td className="px-4 py-3 font-semibold text-foreground">{formatCurrency(order.total_price)}</td>
                        <td className="px-4 py-3 text-muted-foreground">{formatAge(order.created_at)}</td>
                        <td className="px-4 py-3">
                          {result ? getResultBadge(result) : <span className="text-xs text-muted-foreground">—</span>}
                          {result?.fulfillment && result.fulfillment !== "skipped (tracking exists)" && (
                            <p className="mt-0.5 text-xs text-muted-foreground">Fulfillment: {result.fulfillment}</p>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Button
                            size="sm"
                            variant={result ? "outline" : "default"}
                            onClick={() => reverifyOrder(order)}
                            disabled={isProcessing}
                            className={`text-xs ${!result ? "bg-[#1b388b] hover:bg-[#1b388b]/90 text-white" : ""}`}
                          >
                            {isProcessing ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <><Zap className="w-3 h-3 mr-1" />{result ? "Re-check" : "Reverify"}</>
                            )}
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Showing {(page - 1) * limit + 1}–{Math.min(page * limit, totalCount)} of {totalCount}
            </p>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage((p) => p - 1)} disabled={page <= 1} className="flex h-8 w-8 items-center justify-center rounded-full border border-border disabled:opacity-40">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-xs font-semibold text-foreground">{page} / {totalPages}</span>
              <button onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages} className="flex h-8 w-8 items-center justify-center rounded-full border border-border disabled:opacity-40">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
