"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import {
  Users, Package, Store, TrendingUp, TrendingDown, AlertCircle, Download, Wallet, Loader2,
  MessageSquare, Settings, Search, Banknote, Crown, Send, MessageCircle, CheckCircle2, Crown as AgentsIcon,
  ShoppingCart, Clock, Scale, ArrowRight,
} from "lucide-react"
import { useAdminProtected } from "@/hooks/use-admin"
import { adminDashboardService } from "@/lib/admin-service"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"

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

interface DashboardStats {
  totalUsers: number
  totalShops: number
  totalSubAgents: number
  totalOrders: number
  totalRevenue: number
  pendingShops: number
  completedOrders: number
  successRate: string | number
  totalWalletBalance: number
  totalProfitBalance: number
  // Range-scoped hub fields (get_admin_dashboard_hub_stats)
  range?: "today" | "7d" | "30d"
  rangeRevenue?: number
  rangeRevenuePrevious?: number
  rangeProfit?: number
  rangeOrders?: number
  rangeCompletedOrders?: number
  rangeSuccessRate?: number
  todayOrders?: number
  floatBalance?: number
  debtorsTotal?: number
  debtorsCount?: number
  complaintsPending?: number
  afaPending?: number
  agentsExpiring?: number
  actionsTotal?: number
  chartSeries?: Array<{ date: string; revenue: number; profit: number }>
}

const RANGES = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7D" },
  { id: "30d", label: "30D" },
] as const
type RangeId = (typeof RANGES)[number]["id"]

const MANAGEMENT_SECTIONS = [
  { href: "/admin/packages", label: "Manage Packages", description: "Add, edit, or delete data packages", icon: Package },
  { href: "/admin/users", label: "Manage Users", description: "View users, manage balance and roles", icon: Users },
  { href: "/admin/orders", label: "Order Management", description: "Download and manage orders", icon: Download },
  { href: "/admin/order-payment-status", label: "Order Payment Status", description: "Search and view all order payments", icon: Search },
  { href: "/admin/shops", label: "Shop Approvals", description: "Approve or reject shop creations", icon: Store },
  { href: "/admin/withdrawals", label: "Withdrawal Approvals", description: "Review and approve shop withdrawals", icon: Wallet },
  { href: "/admin/profits-history", label: "Profits History", description: "Track all shop profits crediting", icon: Banknote },
  { href: "/admin/order-history", label: "Order History", description: "View completed order stats and history", icon: TrendingUp },
  { href: "/admin/sub-agent-profits", label: "Sub-Agent Profits", description: "View parent shops and sub-agent profit contributions", icon: TrendingUp },
  { href: "/admin/subscribers", label: "Dealer Subscriptions", description: "Monitor active and expired dealer plans", icon: Crown },
  { href: "/admin/complaints", label: "Customer Complaints", description: "View and resolve customer complaints", icon: MessageSquare },
  { href: "/admin/afa-management", label: "AFA Management", description: "Configure AFA price and view submissions", icon: Settings },
  { href: "/admin/broadcast", label: "Broadcast Messaging", description: "Send bulk SMS and Emails to users", icon: Send },
  { href: "/admin/airtime", label: "Airtime Orders", description: "Manage and fulfil airtime top-up orders", icon: Banknote },
] as const

export default function AdminDashboardPage() {
  const router = useRouter()
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [navigating, setNavigating] = useState<string | null>(null)
  const [range, setRange] = useState<RangeId>("7d")

  useEffect(() => {
    if (isAdmin && !adminLoading) {
      loadStats(range)
      // Trigger background check for scheduled order status updates
      checkScheduledOrders()
      // Cleanup old notifications (older than 72 hours)
      cleanupOldNotifications()
    }
  }, [isAdmin, adminLoading, range])

  const checkScheduledOrders = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      await fetch("/api/orders/check-status", {
        method: "GET",
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
    } catch (error) {
      console.error("Background order check failed:", error)
    }
  }

  const cleanupOldNotifications = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      await fetch("/api/notifications/cleanup", {
        method: "GET",
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
    } catch (error) {
      console.error("Background notification cleanup failed:", error)
    }
  }

  const loadStats = async (r: RangeId) => {
    try {
      const dashboardStats = await adminDashboardService.getDashboardStats(r)
      setStats(dashboardStats)
    } catch (error) {
      console.error("Error loading stats:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to load dashboard stats"
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const handleNavigate = async (path: string) => {
    setNavigating(path)
    await new Promise(resolve => setTimeout(resolve, 200))
    router.push(path)
  }

  if (adminLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="w-8 h-8 animate-spin" />
        </div>
      </DashboardLayout>
    )
  }

  if (!isAdmin) {
    return null
  }

  const revenueChange = stats?.rangeRevenuePrevious
    ? (((stats.rangeRevenue || 0) - stats.rangeRevenuePrevious) / stats.rangeRevenuePrevious) * 100
    : null
  const chart = stats?.chartSeries || []
  const revenueSpark = chart.map((d) => ({ v: d.revenue }))
  const profitSpark = chart.map((d) => ({ v: d.profit }))

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-2xl lg:max-w-6xl space-y-5">
        {/* Header */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Admin Dashboard</h1>
            <p className="mt-1 text-sm text-muted-foreground">Platform performance &amp; operations at a glance.</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-full border border-destructive/20 bg-destructive/10 px-3 py-1.5 text-xs font-bold text-destructive">
              <AlertCircle className="h-3.5 w-3.5" /> {stats?.actionsTotal ?? 0} Actions
            </span>
            <div className="inline-flex gap-1 rounded-full bg-muted p-1">
              {RANGES.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setRange(r.id)}
                  className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${range === r.id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {loading || !stats ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-[#1b388b]" />
          </div>
        ) : (
          <>
            {/* Quick-alert cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button onClick={() => handleNavigate("/admin/complaints")} disabled={navigating !== null} className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4 text-left transition hover:border-[#1b388b]/30 disabled:opacity-60">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-pink-500/10 text-pink-600"><MessageCircle className="h-5 w-5" /></span>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Complaints</p>
                    <p className="font-bold text-foreground">{formatCount(stats.complaintsPending ?? 0)} Issues</p>
                  </div>
                </div>
                {navigating === "/admin/complaints" ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" /> : <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
              </button>
              <button onClick={() => handleNavigate("/admin/afa-management")} disabled={navigating !== null} className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4 text-left transition hover:border-[#1b388b]/30 disabled:opacity-60">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600"><CheckCircle2 className="h-5 w-5" /></span>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">AFA Apps</p>
                    <p className="font-bold text-foreground">{formatCount(stats.afaPending ?? 0)} Pending</p>
                  </div>
                </div>
                {navigating === "/admin/afa-management" ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" /> : <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
              </button>
              <button onClick={() => handleNavigate("/admin/subscribers")} disabled={navigating !== null} className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4 text-left transition hover:border-[#1b388b]/30 disabled:opacity-60 sm:col-span-1">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-600"><AgentsIcon className="h-5 w-5" /></span>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Agents</p>
                    <p className="font-bold text-foreground">{formatCount(stats.agentsExpiring ?? 0)} Expiring</p>
                  </div>
                </div>
                {navigating === "/admin/subscribers" ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" /> : <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
              </button>
            </div>

            {/* KPI cards */}
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              <div className="rounded-2xl border border-border bg-card p-4">
                <div className="flex items-center justify-between">
                  <span className="text-success"><Banknote className="h-5 w-5" /></span>
                  {revenueChange !== null && (
                    <span className={`flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-bold ${revenueChange >= 0 ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
                      {revenueChange >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />} {Math.abs(revenueChange).toFixed(1)}%
                    </span>
                  )}
                </div>
                <p className="mt-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Revenue</p>
                <p className="text-xl font-black text-foreground">GH₵{(stats.rangeRevenue ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                {revenueSpark.length > 1 && (
                  <div className="mt-1 h-8">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={revenueSpark}>
                        <Area type="monotone" dataKey="v" stroke="#16a34a" fill="#16a34a" fillOpacity={0.15} strokeWidth={1.5} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-border bg-card p-4">
                <span className="text-amber-600"><Wallet className="h-5 w-5" /></span>
                <p className="mt-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Profit</p>
                <p className="text-xl font-black text-foreground">GH₵{(stats.rangeProfit ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                {profitSpark.length > 1 && (
                  <div className="mt-1 h-8">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={profitSpark}>
                        <Area type="monotone" dataKey="v" stroke="#d97706" fill="#d97706" fillOpacity={0.15} strokeWidth={1.5} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-border bg-card p-4">
                <span className="text-[#1b388b]"><ShoppingCart className="h-5 w-5" /></span>
                <p className="mt-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Orders</p>
                <p className="text-xl font-black text-foreground">{formatCount(stats.rangeOrders ?? 0)}</p>
              </div>

              <div className="rounded-2xl border border-border bg-card p-4">
                <span className="text-violet-600"><CheckCircle2 className="h-5 w-5" /></span>
                <p className="mt-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Success Rate</p>
                <p className="text-xl font-black text-foreground">{stats.rangeSuccessRate ?? 0}%</p>
              </div>

              <div className="rounded-2xl border border-border bg-card p-4">
                <span className="text-success"><Wallet className="h-5 w-5" /></span>
                <p className="mt-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Float Balance</p>
                <p className="text-xl font-black text-foreground">GH₵{(stats.floatBalance ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
              </div>

              <div className="rounded-2xl border border-border bg-card p-4">
                <span className="text-destructive"><Clock className="h-5 w-5" /></span>
                <p className="mt-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Today&apos;s Orders</p>
                <p className="text-xl font-black text-foreground">{formatCount(stats.todayOrders ?? 0)}</p>
              </div>
            </div>

            {/* Revenue & Profit chart */}
            {chart.length > 1 && (
              <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
                <p className="flex items-center gap-1.5 text-sm font-bold text-foreground">
                  <TrendingUp className="h-4 w-4 text-success" /> Revenue &amp; Profit
                </p>
                <div className="mt-3 h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chart} margin={{ left: -10, right: 10 }}>
                      <defs>
                        <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#16a34a" stopOpacity={0.25} />
                          <stop offset="95%" stopColor="#16a34a" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="profGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#d97706" stopOpacity={0.25} />
                          <stop offset="95%" stopColor="#d97706" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="date" tickFormatter={(d) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" })} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} width={40} />
                      <Tooltip
                        contentStyle={{ background: "#0f172a", border: "none", borderRadius: 12, color: "#fff" }}
                        labelFormatter={(d) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        formatter={(value: number, name: string) => [`GH₵${value.toFixed(2)}`, name === "revenue" ? "Revenue" : "Profit"]}
                      />
                      <Area type="monotone" dataKey="revenue" stroke="#16a34a" fill="url(#revGrad)" strokeWidth={2} />
                      <Area type="monotone" dataKey="profit" stroke="#d97706" fill="url(#profGrad)" strokeWidth={2} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Float & Liability */}
            <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
              <div className="flex items-center justify-between">
                <p className="flex items-center gap-1.5 text-sm font-bold text-foreground">
                  <Scale className="h-4 w-4 text-[#1b388b]" /> Float &amp; Liability
                </p>
                <span className={`flex items-center gap-1.5 text-xs font-bold ${(stats.debtorsCount ?? 0) === 0 ? "text-success" : "text-amber-600"}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${(stats.debtorsCount ?? 0) === 0 ? "bg-success" : "bg-amber-500"}`} />
                  {(stats.debtorsCount ?? 0) === 0 ? "Healthy" : "Needs attention"}
                </span>
              </div>

              <div className="mt-4">
                <p className="text-xs text-muted-foreground">Wallet liability (held for users)</p>
                <p className="text-2xl font-black text-foreground">GH₵{(stats.floatBalance ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
              </div>

              <div className="mt-4 border-t border-border pt-4">
                <p className="text-xs text-muted-foreground">Outstanding debt owed to you</p>
                <div className="flex items-end justify-between">
                  <p className="text-xl font-black text-destructive">GH₵{(stats.debtorsTotal ?? 0).toFixed(2)}</p>
                  <span className="text-xs text-muted-foreground">{stats.debtorsCount ?? 0} debtor{(stats.debtorsCount ?? 0) === 1 ? "" : "s"}</span>
                </div>
                <button onClick={() => handleNavigate("/admin/debtors")} disabled={navigating !== null} className="mt-2 flex items-center gap-1 text-sm font-bold text-destructive hover:underline">
                  {navigating === "/admin/debtors" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Review settlements <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Pending Shop Approvals Alert */}
            {stats.pendingShops > 0 && (
              <button
                onClick={() => handleNavigate("/admin/shops")}
                disabled={navigating !== null}
                className="flex w-full items-center justify-between gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-left disabled:opacity-60"
              >
                <div className="flex items-center gap-3">
                  <AlertCircle className="h-6 w-6 shrink-0 text-amber-600" />
                  <div>
                    <p className="font-semibold text-foreground">{formatCount(stats.pendingShops)} Pending Shop Approval{stats.pendingShops !== 1 ? "s" : ""}</p>
                    <p className="text-sm text-muted-foreground">There are shops waiting for approval</p>
                  </div>
                </div>
                {navigating === "/admin/shops" ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-600" />
                ) : (
                  <span className="shrink-0 rounded-full bg-amber-500 px-3 py-1.5 text-xs font-bold text-white">Review Now</span>
                )}
              </button>
            )}

            {/* All-time platform totals */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-3">
              <div className="rounded-2xl border border-border bg-card p-4">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#1b388b]/10 text-[#1b388b]"><Users className="h-4 w-4" /></span>
                <p className="mt-2 text-lg font-black text-foreground">{formatCount(stats.totalUsers)}</p>
                <p className="text-xs text-muted-foreground">Total users</p>
              </div>
              <div className="rounded-2xl border border-border bg-card p-4">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-success/10 text-success"><Store className="h-4 w-4" /></span>
                <p className="mt-2 text-lg font-black text-foreground">{formatCount(stats.totalShops)}</p>
                <p className="text-xs text-muted-foreground">Active shops</p>
              </div>
              <div className="rounded-2xl border border-border bg-card p-4">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#1b388b]/10 text-[#1b388b]"><Users className="h-4 w-4" /></span>
                <p className="mt-2 text-lg font-black text-foreground">{formatCount(stats.totalSubAgents)}</p>
                <p className="text-xs text-muted-foreground">Active sub-agents</p>
              </div>
              <div className="rounded-2xl border border-border bg-card p-4">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-success/10 text-success"><TrendingUp className="h-4 w-4" /></span>
                <p className="mt-2 text-lg font-black text-foreground">GH₵{stats.totalRevenue.toFixed(2)}</p>
                <p className="text-xs text-muted-foreground">All-time revenue</p>
              </div>
              <div className="rounded-2xl border border-border bg-card p-4">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#1b388b]/10 text-[#1b388b]"><TrendingUp className="h-4 w-4" /></span>
                <p className="mt-2 text-lg font-black text-foreground">GH₵{stats.totalProfitBalance.toFixed(2)}</p>
                <p className="text-xs text-muted-foreground">Users&apos; unwithdrawn profit</p>
              </div>
              <div className="rounded-2xl border border-border bg-card p-4">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-success/10 text-success"><Wallet className="h-4 w-4" /></span>
                <p className="mt-2 text-lg font-black text-foreground">GH₵{stats.totalWalletBalance.toFixed(2)}</p>
                <p className="text-xs text-muted-foreground">Users&apos; wallet balance</p>
              </div>
            </div>

            {/* Management Sections */}
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              {MANAGEMENT_SECTIONS.map(({ href, label, description, icon: Icon }) => (
                <button
                  key={href}
                  onClick={() => handleNavigate(href)}
                  disabled={navigating !== null}
                  className="rounded-2xl border border-border bg-card p-4 text-left transition hover:border-[#1b388b]/30 disabled:opacity-60"
                >
                  <div className="flex items-center justify-between">
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#1b388b]/10 text-[#1b388b]"><Icon className="h-5 w-5" /></span>
                    {navigating === href && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                  </div>
                  <p className="mt-3 font-bold text-foreground">{label}</p>
                  <p className="text-xs text-muted-foreground">{description}</p>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  )
}
