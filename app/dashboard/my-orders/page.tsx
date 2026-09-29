"use client"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  ShoppingCart, CheckCircle2, Clock, XCircle, Loader2, RefreshCw, MessageSquare,
  Search, ChevronLeft, ChevronRight,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/hooks/use-auth"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { ComplaintModal } from "@/components/complaint-modal"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"

// Format large numbers with K/M suffix
const formatCount = (num: number): string => {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
  }
  if (num >= 10000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  }
  return num.toLocaleString()
}

interface OrderStats {
  totalOrders: number
  completed: number
  processing: number
  failed: number
  pending: number
  reversed: number
  successRate: number
  totalAmount: number
  totalData: number
}

interface Order {
  id: string
  created_at: string
  phone_number: string
  total_price: number
  order_status: string
  network_name: string
  package_name: string
}

const DATE_PILLS = [
  { id: "all", label: "All" },
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yest." },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "custom", label: "Custom" },
]

// Reversed is this app's real "provider completed->failed flip" status --
// not a fabricated "Refunded" tile; a reversed order isn't necessarily a
// wallet refund event, so it's labeled with its actual status name.
const STATUS_TILES: { key: keyof OrderStats; label: string; icon: typeof Clock; bg: string; fg: string }[] = [
  { key: "pending", label: "Pending", icon: Clock, bg: "bg-warning/10", fg: "text-warning" },
  { key: "processing", label: "Processing", icon: Loader2, bg: "bg-[#1b388b]/10", fg: "text-[#1b388b]" },
  { key: "completed", label: "Completed", icon: CheckCircle2, bg: "bg-success/10", fg: "text-success" },
  { key: "failed", label: "Failed", icon: XCircle, bg: "bg-destructive/10", fg: "text-destructive" },
  { key: "reversed", label: "Reversed", icon: RefreshCw, bg: "bg-violet-600/10", fg: "text-violet-600" },
]

export default function MyOrdersPage() {
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()
  const [stats, setStats] = useState<OrderStats>({
    totalOrders: 0, completed: 0, processing: 0, failed: 0, pending: 0, reversed: 0,
    successRate: 0, totalAmount: 0, totalData: 0,
  })
  const [orders, setOrders] = useState<Order[]>([])
  const [pagination, setPagination] = useState({ total: 0, pages: 1 })
  const [loading, setLoading] = useState(true)
  const [searchPhone, setSearchPhone] = useState("")
  const [filters, setFilters] = useState({
    network: "all",
    status: "all",
    dateRange: "all",
  })
  const [customRange, setCustomRange] = useState({ start: "", end: "" })
  const [page, setPage] = useState(1)
  const [complaintModalOpen, setComplaintModalOpen] = useState(false)
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const fetchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pageSize = 10

  // Auth protection
  useEffect(() => {
    if (!authLoading && !user) {
      router.push("/auth/login")
    }
  }, [user, authLoading, router])

  // Debounce fetches so rapid filter clicks only trigger one request
  useEffect(() => {
    if (!user) return
    if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current)
    fetchDebounceRef.current = setTimeout(fetchOrdersData, 300)
    return () => {
      if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current)
    }
  }, [filters, customRange, searchPhone, page, user])

  const fetchOrdersData = async () => {
    try {
      const [{ data: { user } }, { data: { session } }] = await Promise.all([
        supabase.auth.getUser(),
        supabase.auth.getSession(),
      ])
      if (!user || !session?.access_token) return

      const token = session.access_token
      const queryParams = new URLSearchParams()
      queryParams.append("page", page.toString())
      queryParams.append("limit", pageSize.toString())
      if (filters.network !== "all") queryParams.append("network", filters.network)
      if (filters.status !== "all") queryParams.append("status", filters.status)
      if (filters.dateRange !== "all") queryParams.append("dateRange", filters.dateRange)
      if (filters.dateRange === "custom") {
        if (customRange.start) queryParams.append("startDate", customRange.start)
        if (customRange.end) queryParams.append("endDate", customRange.end)
      }
      if (searchPhone.trim()) queryParams.append("phone", searchPhone.trim())

      const [statsRes, ordersRes] = await Promise.all([
        fetch("/api/orders/stats", { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`/api/orders/list?${queryParams.toString()}`, { headers: { Authorization: `Bearer ${token}` } }),
      ])

      if (statsRes.ok) {
        const statsData = await statsRes.json()
        setStats(statsData)
        localStorage.setItem('userPendingOrdersCount', statsData.pending.toString())
      }
      if (ordersRes.ok) {
        const ordersData = await ordersRes.json()
        setOrders(ordersData.orders || [])
        if (ordersData.pagination) setPagination({ total: ordersData.pagination.total, pages: Math.max(1, ordersData.pagination.pages) })
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to load orders"
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="max-w-2xl mx-auto space-y-5">
          <Skeleton className="h-10 w-64 mx-auto" />
          <div className="grid grid-cols-3 gap-2">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
          </div>
          <Skeleton className="h-12 w-full rounded-2xl" />
        </div>
      </DashboardLayout>
    )
  }

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case "completed": return "bg-success/15 text-success"
      case "processing": return "bg-[#1b388b]/10 text-[#1b388b]"
      case "failed": return "bg-destructive/15 text-destructive"
      case "reversed": return "bg-violet-600/10 text-violet-600"
      case "placed": return "bg-[#1b388b]/10 text-[#1b388b]"
      case "held_registration": return "bg-warning/10 text-warning"
      default: return "bg-muted text-foreground"
    }
  }

  const getStatusLabel = (status: string) =>
    status === "held_registration"
      ? "Activating number"
      : status.charAt(0).toUpperCase() + status.slice(1)

  return (
    <DashboardLayout>
      <div className="max-w-2xl mx-auto space-y-5">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-3xl font-black text-foreground">My Order History</h1>
          <p className="mt-1 text-sm text-muted-foreground">View and manage your order transactions</p>
        </div>

        {/* Totals -- navy/blue-black family, not the reference's black+yellow */}
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <div className="rounded-2xl bg-[#0f172a] p-4 text-center">
            <p className="text-2xl font-black text-white">{formatCount(stats.totalOrders)}</p>
            <p className="mt-1 text-xs font-medium text-white/70">Total Orders</p>
          </div>
          <div className="rounded-2xl bg-[#1b388b] p-4 text-center">
            <p className="text-2xl font-black text-white">₵{stats.totalAmount.toFixed(2)}</p>
            <p className="mt-1 text-xs font-medium text-white/70">Total Amount</p>
          </div>
          <div className="rounded-2xl bg-[#16213e] p-4 text-center">
            <p className="text-2xl font-black text-white">{stats.totalData.toFixed(2)} GB</p>
            <p className="mt-1 text-xs font-medium text-white/70">Total Data</p>
          </div>
        </div>

        {/* Status tiles -- Pending/Processing/Completed/Failed/Reversed are
            this app's real 5 order statuses. No "Queued" tile: there's no
            such status here, so it isn't shown rather than being invented. */}
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          {STATUS_TILES.map(({ key, label, icon: Icon, bg, fg }) => (
            <div key={key} className="rounded-2xl border border-border bg-card p-4">
              <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${bg} ${fg}`}>
                <Icon className="h-4 w-4" />
              </span>
              <p className="mt-2 text-xl font-black text-foreground">{formatCount(stats[key] as number)}</p>
              <p className="text-xs text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>

        {/* Quick date filter */}
        <div className="flex flex-wrap gap-2">
          {DATE_PILLS.map((p) => (
            <button
              key={p.id}
              onClick={() => { setFilters(f => ({ ...f, dateRange: p.id })); setPage(1) }}
              className={`rounded-full border px-4 py-2 text-sm font-bold transition ${
                filters.dateRange === p.id ? "border-[#1b388b] bg-[#1b388b] text-primary-foreground" : "border-border bg-card text-foreground hover:border-[#1b388b]/30"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        {filters.dateRange === "custom" && (
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card p-3">
            <label className="flex-1 min-w-[140px] text-xs font-semibold text-muted-foreground">
              From
              <input
                type="date"
                value={customRange.start}
                onChange={(e) => { setCustomRange(r => ({ ...r, start: e.target.value })); setPage(1) }}
                className="mt-1 block w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground"
              />
            </label>
            <label className="flex-1 min-w-[140px] text-xs font-semibold text-muted-foreground">
              To
              <input
                type="date"
                value={customRange.end}
                onChange={(e) => { setCustomRange(r => ({ ...r, end: e.target.value })); setPage(1) }}
                className="mt-1 block w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground"
              />
            </label>
          </div>
        )}

        {/* Search by phone */}
        <div className="space-y-2">
          <p className="text-sm font-bold text-foreground">Search by Phone</p>
          <div className="relative">
            <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Enter phone number"
              value={searchPhone}
              onChange={(e) => { setSearchPhone(e.target.value); setPage(1) }}
              className="rounded-2xl border-border bg-card py-5 pl-11"
            />
          </div>
        </div>

        {/* Filter by status / network */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <p className="text-sm font-bold text-foreground">Filter by Status</p>
            <select
              value={filters.status}
              onChange={(e) => { setFilters({ ...filters, status: e.target.value }); setPage(1) }}
              className="w-full rounded-2xl border border-border bg-card px-3 py-3 text-sm text-foreground"
            >
              <option value="all">All Statuses</option>
              <option value="pending">Pending</option>
              <option value="processing">Processing</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="reversed">Reversed</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <p className="text-sm font-bold text-foreground">Filter by Network</p>
            <select
              value={filters.network}
              onChange={(e) => { setFilters({ ...filters, network: e.target.value }); setPage(1) }}
              className="w-full rounded-2xl border border-border bg-card px-3 py-3 text-sm text-foreground"
            >
              <option value="all">All Networks</option>
              <option value="MTN">MTN</option>
              <option value="Telecel">Telecel</option>
              <option value="AT - iShare">AT - iShare</option>
              <option value="AT - BigTime">AT - BigTime</option>
            </select>
          </div>
        </div>

        {/* Orders list */}
        {orders.length === 0 ? (
          <div className="rounded-2xl border border-border bg-card py-16 text-center">
            <ShoppingCart className="mx-auto h-10 w-10 text-muted-foreground" />
            <p className="mt-3 text-muted-foreground">No orders found</p>
          </div>
        ) : (
          <div className="space-y-2">
            {orders.map((order) => (
              <div key={order.id} className="rounded-2xl border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-bold text-foreground">{order.package_name}</p>
                    <p className="text-xs text-muted-foreground">{order.network_name}</p>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">{order.phone_number}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-bold text-foreground">GHS {(order.total_price || 0).toFixed(2)}</p>
                    <Badge className={`mt-1 ${getStatusBadgeColor(order.order_status)}`}>{getStatusLabel(order.order_status)}</Badge>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
                  <p className="text-xs text-muted-foreground">
                    {new Date(order.created_at).toLocaleDateString()} · {new Date(order.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { setSelectedOrder(order); setComplaintModalOpen(true) }}
                    className="gap-1 rounded-full"
                    title="File a complaint for this order"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    Complain
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Pagination -- real page count from the API (was previously
            ignored; Next/Prev used to guess from the current page's row
            count instead of the actual total). */}
        <div className="flex items-center justify-center gap-4">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            aria-label="Previous page"
            className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-card text-foreground disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <p className="text-sm font-bold text-foreground">{page} / {pagination.pages}</p>
          <button
            onClick={() => setPage(p => Math.min(pagination.pages, p + 1))}
            disabled={page >= pagination.pages}
            aria-label="Next page"
            className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-card text-foreground disabled:opacity-40"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Complaint Modal */}
      {selectedOrder && (
        <ComplaintModal
          isOpen={complaintModalOpen}
          onClose={() => {
            setComplaintModalOpen(false)
            setSelectedOrder(null)
          }}
          orderId={selectedOrder.id}
          orderType="regular"
          orderDetails={{
            networkName: selectedOrder.network_name,
            packageName: selectedOrder.package_name,
            phoneNumber: selectedOrder.phone_number,
            totalPrice: selectedOrder.total_price,
            createdAt: selectedOrder.created_at,
          }}
        />
      )}
    </DashboardLayout>
  )
}
