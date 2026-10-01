"use client"

import { useEffect, useMemo, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { DashboardHeroBanner } from "@/components/shared/dashboard-hero-banner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { shopService, shopOrderService } from "@/lib/shop-service"
import { supabase } from "@/lib/supabase"
import {
  ShoppingCart, RefreshCw, Search, Clock, Loader2 as ProcessingIcon,
  CheckCircle2, XCircle, RotateCcw, Banknote, TrendingUp, ChevronLeft, ChevronRight,
} from "lucide-react"
import { toast } from "sonner"

type OrderType = "data" | "airtime" | "voucher"
type DateRange = "today" | "7d" | "30d" | "all"

interface UnifiedOrder {
  id: string
  type: OrderType
  reference: string
  customer_phone: string
  package_label: string
  amount: number
  profit: number
  status: string
  source: "web" | "ussd_shop" | "whatsapp_shop"
  created_at: string
}

const CATEGORY_TABS = [
  { id: "all", label: "All", icon: TrendingUp },
  { id: "data", label: "Data", icon: ShoppingCart },
  { id: "airtime", label: "Airtime", icon: RefreshCw },
  { id: "voucher", label: "Vouchers", icon: Banknote },
] as const
type CategoryTab = (typeof CATEGORY_TABS)[number]["id"]

const DATE_RANGES = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 Days" },
  { id: "30d", label: "30 Days" },
  { id: "all", label: "All" },
] as const

// Real order_status/status vocabulary confirmed across shop_orders,
// ussd_shop_orders, airtime_orders, results_checker_orders: pending,
// processing, completed, failed, held_registration ("Activating number",
// data orders only), reversed (data orders only). No "Queued"/"Refunded"
// status exists on any of these tables -- those were reference-only.
const STATUS_META: Record<string, { label: string; badge: string }> = {
  pending: { label: "Pending", badge: "bg-warning/15 text-warning" },
  processing: { label: "Processing", badge: "bg-[#1b388b]/10 text-[#1b388b]" },
  held_registration: { label: "Activating number", badge: "bg-[#1b388b]/10 text-[#1b388b]" },
  completed: { label: "Completed", badge: "bg-success/15 text-success" },
  failed: { label: "Failed", badge: "bg-destructive/15 text-destructive" },
  reversed: { label: "Reversed", badge: "bg-destructive/15 text-destructive" },
  expired: { label: "Expired", badge: "bg-muted text-muted-foreground" },
}

function isWithinRange(dateStr: string, range: DateRange): boolean {
  if (range === "all") return true
  const d = new Date(dateStr).getTime()
  const now = Date.now()
  const days = range === "today" ? 1 : range === "7d" ? 7 : 30
  const start = range === "today" ? new Date(new Date().setHours(0, 0, 0, 0)).getTime() : now - days * 24 * 60 * 60 * 1000
  return d >= start
}

export default function ShopOrdersPage() {
  const { user } = useAuth()
  const [shop, setShop] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [orders, setOrders] = useState<UnifiedOrder[]>([])

  const [category, setCategory] = useState<CategoryTab>("all")
  const [dateRange, setDateRange] = useState<DateRange>("today")
  const [search, setSearch] = useState("")
  const [networkFilter, setNetworkFilter] = useState("all")
  const [statusFilter, setStatusFilter] = useState("all")
  const [sourceFilter, setSourceFilter] = useState("all")
  const [page, setPage] = useState(1)
  const pageSize = 20

  useEffect(() => {
    if (!user) return
    loadData()
  }, [user])

  const loadData = async () => {
    try {
      setLoading(true)
      if (!user?.id) return
      const userShop = await shopService.getShop(user.id)
      setShop(userShop)
      if (!userShop) return

      const [dataOrders, airtimeRes, voucherRes] = await Promise.all([
        shopOrderService.getShopOrders(userShop.id).catch(() => []),
        supabase.from("airtime_orders").select("*").eq("shop_id", userShop.id).eq("payment_status", "completed").order("created_at", { ascending: false }),
        supabase.from("results_checker_orders").select("*").eq("shop_id", userShop.id).eq("payment_status", "completed").order("created_at", { ascending: false }),
      ])

      const unifiedData: UnifiedOrder[] = dataOrders.map((o: any) => ({
        id: o.id,
        type: "data",
        reference: o.reference_code || String(o.id).slice(0, 8),
        customer_phone: o.customer_phone,
        package_label: `${o.network} ${o.volume_gb}GB`,
        amount: Number(o.total_price) || 0,
        profit: Number(o.profit_amount) || 0,
        status: o.order_status,
        source: o.channel === "whatsapp_shop" ? "whatsapp_shop" : o.type === "ussd_shop" ? "ussd_shop" : "web",
        created_at: o.created_at,
      }))

      const unifiedAirtime: UnifiedOrder[] = (airtimeRes.data || []).map((o: any) => ({
        id: o.id,
        type: "airtime",
        reference: o.reference_code || String(o.id).slice(0, 8),
        customer_phone: o.beneficiary_phone,
        package_label: `${o.network} Airtime GH₵${Number(o.airtime_amount || 0).toFixed(2)}`,
        amount: Number(o.total_paid) || 0,
        profit: Number(o.merchant_commission) || 0,
        status: o.status,
        source: o.channel === "whatsapp_shop" ? "whatsapp_shop" : o.channel === "ussd_shop" ? "ussd_shop" : "web",
        created_at: o.created_at,
      }))

      const unifiedVouchers: UnifiedOrder[] = (voucherRes.data || []).map((o: any) => ({
        id: o.id,
        type: "voucher",
        reference: o.reference_code || String(o.id).slice(0, 8),
        customer_phone: o.customer_phone || "—",
        package_label: `${o.exam_board} × ${o.quantity}`,
        amount: Number(o.total_paid) || 0,
        profit: Number(o.merchant_commission) || 0,
        status: o.status,
        source: o.channel === "whatsapp_shop" ? "whatsapp_shop" : o.channel === "ussd_shop" ? "ussd_shop" : "web",
        created_at: o.created_at,
      }))

      const all = [...unifiedData, ...unifiedAirtime, ...unifiedVouchers].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )
      setOrders(all)
    } catch (error) {
      console.error("Error loading shop orders:", error)
      toast.error(error instanceof Error ? error.message : "Failed to load orders")
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  const handleRefresh = () => { setRefreshing(true); loadData() }

  const networks = useMemo(() => {
    const set = new Set<string>()
    orders.forEach((o) => { if (o.type === "data") { const n = o.package_label.split(" ")[0]; if (n) set.add(n) } })
    return Array.from(set)
  }, [orders])

  const filtered = useMemo(() => {
    return orders.filter((o) => {
      if (category !== "all" && o.type !== category) return false
      if (!isWithinRange(o.created_at, dateRange)) return false
      if (search.trim() && !o.customer_phone?.includes(search.trim())) return false
      if (networkFilter !== "all" && !o.package_label.startsWith(networkFilter)) return false
      if (statusFilter !== "all" && o.status !== statusFilter) return false
      if (sourceFilter !== "all" && o.source !== sourceFilter) return false
      return true
    })
  }, [orders, category, dateRange, search, networkFilter, statusFilter, sourceFilter])

  const stats = useMemo(() => {
    const pending = filtered.filter((o) => o.status === "pending").length
    const processing = filtered.filter((o) => o.status === "processing" || o.status === "held_registration").length
    const completed = filtered.filter((o) => o.status === "completed").length
    const failed = filtered.filter((o) => o.status === "failed" || o.status === "expired").length
    const reversed = filtered.filter((o) => o.status === "reversed").length
    const revenue = filtered.reduce((s, o) => s + o.amount, 0)
    const profit = filtered.reduce((s, o) => s + o.profit, 0)
    return { total: filtered.length, pending, processing, completed, failed, reversed, revenue, profit }
  }, [filtered])

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const pageOrders = filtered.slice((page - 1) * pageSize, page * pageSize)

  useEffect(() => { setPage(1) }, [category, dateRange, search, networkFilter, statusFilter, sourceFilter])

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <ProcessingIcon className="w-8 h-8 animate-spin text-[#1b388b]" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-2xl lg:max-w-4xl space-y-5">
        <DashboardHeroBanner backHref="/dashboard/my-shop" title="Shop Orders" icon={ShoppingCart}>
          <Button variant="outline" size="sm" className="rounded-full border-white/25 bg-white/10 text-white hover:bg-white/20 hover:text-white" onClick={handleRefresh} disabled={refreshing}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshing ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </DashboardHeroBanner>

        {/* Category tabs */}
        <div className="-mx-2 overflow-x-auto px-2 sm:mx-0 sm:px-0">
          <div className="inline-flex min-w-full gap-1 rounded-2xl bg-muted p-1 sm:min-w-0">
            {CATEGORY_TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setCategory(id)}
                className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-bold transition ${category === id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
              >
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search phone number..."
            className="w-full rounded-2xl border border-border bg-card py-2.5 pl-10 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-[#1b388b]/30"
          />
        </div>

        {/* Date range */}
        <div className="inline-flex w-full gap-1 rounded-2xl bg-muted p-1">
          {DATE_RANGES.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setDateRange(id)}
              className={`flex-1 rounded-xl py-2 text-xs font-bold transition ${dateRange === id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Filters */}
        <div className="grid grid-cols-3 gap-2">
          <select value={networkFilter} onChange={(e) => setNetworkFilter(e.target.value)} className="rounded-2xl border border-border bg-card px-2 py-2.5 text-xs font-semibold text-foreground">
            <option value="all">All Networks</option>
            {networks.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-2xl border border-border bg-card px-2 py-2.5 text-xs font-semibold text-foreground">
            <option value="all">All Status</option>
            {Object.entries(STATUS_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} className="rounded-2xl border border-border bg-card px-2 py-2.5 text-xs font-semibold text-foreground">
            <option value="all">All Sources</option>
            <option value="web">Web</option>
            <option value="ussd_shop">USSD</option>
            <option value="whatsapp_shop">WhatsApp</option>
          </select>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><ShoppingCart className="h-3.5 w-3.5" /> Orders</p>
            <p className="mt-1 text-xl font-black text-foreground">{stats.total}</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Clock className="h-3.5 w-3.5" /> Pending</p>
            <p className="mt-1 text-xl font-black text-foreground">{stats.pending}</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><ProcessingIcon className="h-3.5 w-3.5" /> Processing</p>
            <p className="mt-1 text-xl font-black text-foreground">{stats.processing}</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><CheckCircle2 className="h-3.5 w-3.5" /> Completed</p>
            <p className="mt-1 text-xl font-black text-foreground">{stats.completed}</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><XCircle className="h-3.5 w-3.5" /> Failed</p>
            <p className="mt-1 text-xl font-black text-foreground">{stats.failed}</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><RotateCcw className="h-3.5 w-3.5" /> Reversed</p>
            <p className="mt-1 text-xl font-black text-foreground">{stats.reversed}</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Banknote className="h-3.5 w-3.5" /> Revenue</p>
            <p className="mt-1 text-xl font-black text-foreground">GH₵{stats.revenue.toFixed(2)}</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><TrendingUp className="h-3.5 w-3.5" /> Profit</p>
            <p className="mt-1 text-xl font-black text-foreground">GH₵{stats.profit.toFixed(2)}</p>
          </div>
        </div>

        {/* Order History */}
        <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
          <p className="text-sm font-bold text-foreground">Order History</p>
          {pageOrders.length === 0 ? (
            <p className="mt-4 py-8 text-center text-sm text-muted-foreground">No orders found matching your filters.</p>
          ) : (
            <div className="mt-3 space-y-2 lg:grid lg:grid-cols-2 lg:gap-3 lg:space-y-0">
              {pageOrders.map((o) => {
                const meta = STATUS_META[o.status] || { label: o.status || "Unknown", badge: "bg-muted text-foreground" }
                return (
                  <div key={`${o.type}-${o.id}`} className="rounded-2xl border border-border bg-muted/30 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-foreground">{o.package_label}</p>
                        <p className="text-xs text-muted-foreground">{o.customer_phone} · {new Date(o.created_at).toLocaleDateString()}</p>
                      </div>
                      <Badge className={meta.badge}>{meta.label}</Badge>
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">{o.reference}</span>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-foreground">GH₵{o.amount.toFixed(2)}</p>
                        <p className="text-xs text-success">+GH₵{o.profit.toFixed(2)}</p>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">{filtered.length === 0 ? "No orders found" : `${filtered.length} order${filtered.length === 1 ? "" : "s"}`}</p>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="flex h-8 w-8 items-center justify-center rounded-full border border-border disabled:opacity-40">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-xs font-semibold text-foreground">{page} / {pageCount}</span>
            <button onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={page >= pageCount} className="flex h-8 w-8 items-center justify-center rounded-full border border-border disabled:opacity-40">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </DashboardLayout>
  )
}
