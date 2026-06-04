"use client"

import { useState, useEffect, useCallback } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Search,
  RefreshCw,
  ShoppingCart,
  Smartphone,
  Clock,
  CheckCircle,
  XCircle,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Zap,
} from "lucide-react"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"
import { useAdminProtected } from "@/hooks/use-admin"

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
  order_type: "data" | "airtime"
  reference_code: string       // internal ORD-/AT- ref (display only)
  wallet_reference: string          // WALLET- ref used with Paystack
  customer_phone: string
  customer_name?: string
  network: string
  amount: number
  payment_status: string
  order_status?: string
  status?: string
  created_at: string
}

interface Stats {
  total: number
  dataOrders: number
  airtimeOrders: number
  oldestPending: string | null
}

interface ReverifyResult {
  id: string
  reference: string
  order_type: string
  paystack_status: string
  action: string
  fulfillment?: string
}

const defaultStats: Stats = { total: 0, dataOrders: 0, airtimeOrders: 0, oldestPending: null }

export default function PaymentReverifyPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()

  const [orders, setOrders] = useState<PendingOrder[]>([])
  const [stats, setStats] = useState<Stats>(defaultStats)
  const [loading, setLoading] = useState(true)
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set())
  const [bulkRunning, setBulkRunning] = useState(false)
  const [rowResults, setRowResults] = useState<Record<string, ReverifyResult>>({})

  // Filters
  const [search, setSearch] = useState("")
  const [typeFilter, setTypeFilter] = useState("all")
  const [startDate, setStartDate] = useState("")
  const [endDate, setEndDate] = useState("")

  // Pagination
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [totalCount, setTotalCount] = useState(0)
  const limit = 20

  // Bulk results dialog
  const [bulkResults, setBulkResults] = useState<ReverifyResult[] | null>(null)

  const getAuthHeader = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) throw new Error("Not authenticated")
    return `Bearer ${session.access_token}`
  }, [])

  const fetchOrders = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: page.toString(), limit: limit.toString() })
      if (search) params.append("search", search)
      if (typeFilter !== "all") params.append("orderType", typeFilter)
      if (startDate) params.append("startDate", startDate)
      if (endDate) params.append("endDate", endDate)

      const auth = await getAuthHeader()
      const res = await fetch(`/api/admin/payment-reverify?${params}`, {
        headers: { Authorization: auth },
      })
      if (!res.ok) throw new Error("Failed to fetch pending orders")
      const data = await res.json()

      setOrders(data.orders || [])
      setStats(data.stats || defaultStats)
      setTotalPages(data.pagination?.totalPages || 1)
      setTotalCount(data.pagination?.totalCount || 0)
      // Clear row results on refresh
      setRowResults({})
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load pending orders")
    } finally {
      setLoading(false)
    }
  }, [page, search, typeFilter, startDate, endDate, getAuthHeader])

  useEffect(() => {
    fetchOrders()
  }, [fetchOrders])

  useEffect(() => {
    setPage(1)
  }, [search, typeFilter, startDate, endDate])

  const reverifyOrder = async (order: PendingOrder) => {
    setProcessingIds((prev) => new Set(prev).add(order.id))
    try {
      const auth = await getAuthHeader()
      const res = await fetch("/api/admin/payment-reverify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({
          orderId: order.id,
          orderType: order.order_type,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Reverify failed")

      const result: ReverifyResult = data.results?.[0]
      if (result) {
        setRowResults((prev) => ({ ...prev, [order.id]: result }))
        if (result.paystack_status === "success") {
          toast.success(`${order.reference_code} — verified & processed`)
        } else if (result.action === "already_processed") {
          toast.info(`${order.reference_code} — already processed`)
        } else if (result.paystack_status === "pending") {
          toast.warning(`${order.reference_code} — still pending on Paystack`)
        } else {
          toast.error(`${order.reference_code} — ${result.paystack_status}`)
        }
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

  const reverifyAll = async (bulkType: "all" | "data" | "airtime" = "all") => {
    if (!confirm(`Reverify all pending ${bulkType === "all" ? "" : bulkType + " "}orders with Paystack? (up to 50 at a time)`)) return
    setBulkRunning(true)
    try {
      const auth = await getAuthHeader()
      const res = await fetch("/api/admin/payment-reverify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({ bulk: true, bulkType }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Bulk reverify failed")

      toast.success(
        `Bulk complete — verified: ${data.verified}, fulfilled: ${data.fulfilled}, failed: ${data.failed}, still pending: ${data.stillPending}`
      )
      setBulkResults(data.results || [])
      fetchOrders()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk reverify failed")
    } finally {
      setBulkRunning(false)
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

  if (adminLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
        </div>
      </DashboardLayout>
    )
  }

  if (!isAdmin) return null

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Payment Reverification</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Manually verify pending orders against Paystack and trigger fulfillment
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={fetchOrders} disabled={loading}>
              <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button
              size="sm"
              onClick={() => reverifyAll("all")}
              disabled={bulkRunning || stats.total === 0}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {bulkRunning ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Zap className="w-4 h-4 mr-2" />
              )}
              Reverify All ({stats.total})
            </Button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Pending</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{stats.total}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
                <ShoppingCart className="w-4 h-4" /> Data Orders
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{stats.dataOrders}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
                <Smartphone className="w-4 h-4" /> Airtime Orders
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{stats.airtimeOrders}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
                <Clock className="w-4 h-4" /> Oldest Pending
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">
                {stats.oldestPending ? formatAge(stats.oldestPending) : "—"}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="pt-4">
            <div className="flex flex-wrap gap-3">
              <div className="relative flex-1 min-w-48">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search reference or phone..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="Order type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="data">Data Only</SelectItem>
                  <SelectItem value="airtime">Airtime Only</SelectItem>
                </SelectContent>
              </Select>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-36"
                placeholder="From"
              />
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-36"
                placeholder="To"
              />
              {(search || typeFilter !== "all" || startDate || endDate) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setSearch(""); setTypeFilter("all"); setStartDate(""); setEndDate("") }}
                >
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
                  <TableHead>Type</TableHead>
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
                    <TableCell colSpan={8} className="text-center py-12">
                      <Loader2 className="w-6 h-6 animate-spin mx-auto text-blue-500" />
                    </TableCell>
                  </TableRow>
                ) : orders.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">
                      <CheckCircle className="w-8 h-8 mx-auto mb-2 text-green-500" />
                      No pending orders found
                    </TableCell>
                  </TableRow>
                ) : (
                  orders.map((order) => {
                    const isProcessing = processingIds.has(order.id)
                    const result = rowResults[order.id]
                    return (
                      <TableRow key={order.id} className={result?.paystack_status === "success" && result.action !== "already_processed" ? "bg-green-50" : undefined}>
                        <TableCell>
                          <p className="font-mono text-xs">{order.wallet_reference}</p>
                          <p className="font-mono text-xs text-muted-foreground">{order.reference_code}</p>
                        </TableCell>
                        <TableCell>
                          {order.order_type === "data" ? (
                            <Badge variant="outline" className="border-blue-500 text-blue-600 text-xs">
                              <ShoppingCart className="w-3 h-3 mr-1" />Data
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="border-purple-500 text-purple-600 text-xs">
                              <Smartphone className="w-3 h-3 mr-1" />Airtime
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <p className="text-sm font-medium">{order.customer_name || "—"}</p>
                          <p className="text-xs text-muted-foreground">{order.customer_phone}</p>
                        </TableCell>
                        <TableCell className="text-sm">{order.network}</TableCell>
                        <TableCell className="text-sm font-medium">{formatCurrency(order.amount)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{formatAge(order.created_at)}</TableCell>
                        <TableCell>
                          {result ? getResultBadge(result) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                          {result?.fulfillment && result.fulfillment !== "skipped (tracking exists)" && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              Fulfillment: {result.fulfillment}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant={result ? "outline" : "default"}
                            onClick={() => reverifyOrder(order)}
                            disabled={isProcessing || bulkRunning}
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
              <span className="text-sm px-2 py-1">
                {page} / {totalPages}
              </span>
              <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages}>
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Bulk results dialog */}
      <Dialog open={!!bulkResults} onOpenChange={(open) => !open && setBulkResults(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Bulk Reverification Results</DialogTitle>
          </DialogHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Paystack</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(bulkResults || []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.reference}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs">{r.order_type}</Badge>
                  </TableCell>
                  <TableCell>{getResultBadge(r)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.action}
                    {r.fulfillment && <span className="block">fulfillment: {r.fulfillment}</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}
