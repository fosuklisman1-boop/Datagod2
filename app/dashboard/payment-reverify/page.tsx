"use client"

import { useState, useEffect, useCallback } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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
          ? <Badge className="bg-blue-500 text-xs">Already Done</Badge>
          : <Badge className="bg-green-500 text-xs"><CheckCircle className="w-3 h-3 mr-1" />Verified</Badge>
      case "failed":
        return <Badge className="bg-red-500 text-xs"><XCircle className="w-3 h-3 mr-1" />Failed</Badge>
      case "abandoned":
        return <Badge className="bg-gray-500 text-xs"><AlertTriangle className="w-3 h-3 mr-1" />Abandoned</Badge>
      case "pending":
        return <Badge className="bg-yellow-500 text-xs"><Clock className="w-3 h-3 mr-1" />Still Pending</Badge>
      default:
        return <Badge variant="secondary" className="text-xs">{result.paystack_status}</Badge>
    }
  }

  if (shopLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
        </div>
      </DashboardLayout>
    )
  }

  if (!shopId) {
    return (
      <DashboardLayout>
        <div className="p-6">
          <p className="text-muted-foreground">You don't have a shop set up yet.</p>
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Payment Reverification</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Check pending customer orders against Paystack and trigger fulfillment
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={fetchOrders} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Search */}
        <Card>
          <CardContent className="pt-4">
            <div className="flex gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search by reference, phone or name..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
              {search && (
                <Button variant="ghost" size="sm" onClick={() => setSearch("")}>
                  Clear
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Network</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Age</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-12">
                      <Loader2 className="w-6 h-6 animate-spin mx-auto text-blue-500" />
                    </TableCell>
                  </TableRow>
                ) : orders.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-12 text-muted-foreground">
                      <CheckCircle className="w-8 h-8 mx-auto mb-2 text-green-500" />
                      No pending orders
                    </TableCell>
                  </TableRow>
                ) : (
                  orders.map((order) => {
                    const isProcessing = processingIds.has(order.id)
                    const result = rowResults[order.id]
                    return (
                      <TableRow
                        key={order.id}
                        className={result?.paystack_status === "success" && result.action !== "already_processed" ? "bg-green-50" : undefined}
                      >
                        <TableCell>
                          <p className="font-mono text-xs">{order.wallet_reference}</p>
                          <p className="font-mono text-xs text-muted-foreground">{order.reference_code}</p>
                        </TableCell>
                        <TableCell>
                          <p className="text-sm font-medium">{order.customer_name || "—"}</p>
                          <p className="text-xs text-muted-foreground">{order.customer_phone}</p>
                        </TableCell>
                        <TableCell className="text-sm">{order.network}</TableCell>
                        <TableCell className="text-sm font-medium">{formatCurrency(order.total_price)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{formatAge(order.created_at)}</TableCell>
                        <TableCell>
                          {result ? getResultBadge(result) : <span className="text-xs text-muted-foreground">—</span>}
                          {result?.fulfillment && result.fulfillment !== "skipped (tracking exists)" && (
                            <p className="text-xs text-muted-foreground mt-0.5">Fulfillment: {result.fulfillment}</p>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant={result ? "outline" : "default"}
                            onClick={() => reverifyOrder(order)}
                            disabled={isProcessing}
                            className="text-xs"
                          >
                            {isProcessing ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <><Zap className="w-3 h-3 mr-1" />{result ? "Re-check" : "Reverify"}</>
                            )}
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Showing {(page - 1) * limit + 1}–{Math.min(page * limit, totalCount)} of {totalCount}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setPage((p) => p - 1)} disabled={page <= 1}>
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <span className="text-sm px-2 py-1">{page} / {totalPages}</span>
              <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages}>
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
