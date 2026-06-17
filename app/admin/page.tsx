"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Users, Package, Store, TrendingUp, AlertCircle, Download, Wallet, Loader2, MessageSquare, Settings, Search, Banknote, Crown, Send } from "lucide-react"
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
}

export default function AdminDashboardPage() {
  const router = useRouter()
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [navigating, setNavigating] = useState<string | null>(null)

  useEffect(() => {
    if (isAdmin && !adminLoading) {
      loadStats()
      // Trigger background check for scheduled order status updates
      checkScheduledOrders()
      // Cleanup old notifications (older than 72 hours)
      cleanupOldNotifications()
      // Cleanup old completed download batches (older than 14 days)
      cleanupOldBatches()
    }
  }, [isAdmin, adminLoading])

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

  const cleanupOldBatches = async () => {
    try {
      // Silently cleanup completed download batches older than 14 days
      const { data: { session } } = await supabase.auth.getSession()
      await fetch("/api/admin/batches/cleanup", {
        method: "GET",
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      })
    } catch (error) {
      // Silently fail - this is a background task
      console.error("Background batch cleanup failed:", error)
    }
  }

  const loadStats = async () => {
    try {
      const dashboardStats = await adminDashboardService.getDashboardStats()
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
    // Small delay to show loading state
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

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold bg-gradient-to-r from-red-600 via-primary to-pink-600 bg-clip-text text-transparent">Admin Dashboard</h1>
          <p className="text-muted-foreground mt-1 font-medium">Manage packages, users, and shop approvals</p>
        </div>

        {/* Stats Cards */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 sm:gap-3 lg:gap-4">
            {/* Total Users */}
            <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-blue-500 bg-card backdrop-blur-xl border border-primary/20">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-foreground">Total Users</CardTitle>
                <Users className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold bg-gradient-to-r from-primary to-primary bg-clip-text text-transparent">{formatCount(stats.totalUsers)}</div>
                <p className="text-xs text-muted-foreground">Registered users</p>
              </CardContent>
            </Card>

            {/* Total Shops */}
            <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-success/30 bg-card backdrop-blur-xl border border-border">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-foreground">Total Shops</CardTitle>
                <Store className="h-4 w-4 text-success" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold bg-gradient-to-r from-success to-success bg-clip-text text-transparent">{formatCount(stats.totalShops)}</div>
                <p className="text-xs text-muted-foreground">Active shops</p>
              </CardContent>
            </Card>

            {/* Total Sub-Agents */}
            <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-purple-500 bg-card backdrop-blur-xl border border-border">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-foreground">Total Sub-Agents</CardTitle>
                <Users className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold bg-gradient-to-r from-primary to-primary bg-clip-text text-transparent">{formatCount(stats.totalSubAgents)}</div>
                <p className="text-xs text-muted-foreground">Active sub-agents</p>
              </CardContent>
            </Card>

            {/* Total Orders */}
            <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-warning/30 bg-card backdrop-blur-xl border border-border">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-foreground">Total Orders</CardTitle>
                <Package className="h-4 w-4 text-warning" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold bg-gradient-to-r from-warning to-warning bg-clip-text text-transparent">{formatCount(stats.totalOrders)}</div>
                <p className="text-xs text-muted-foreground">All time orders</p>
              </CardContent>
            </Card>

            {/* Total Revenue */}
            <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-violet-500 bg-card backdrop-blur-xl border border-border">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-foreground">Total Revenue</CardTitle>
                <TrendingUp className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold bg-gradient-to-r from-primary to-primary bg-clip-text text-transparent">GHS {stats.totalRevenue.toFixed(2)}</div>
                <p className="text-xs text-muted-foreground">Platform revenue</p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Users Balance Cards */}
        {stats && (
          <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:gap-4">
            {/* Total Wallet Balance */}
            <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-success/30 bg-card backdrop-blur-xl border border-border">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-foreground">Users Wallet Balance</CardTitle>
                <Wallet className="h-4 w-4 text-success" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold bg-gradient-to-r from-success to-success bg-clip-text text-transparent">GHS {stats.totalWalletBalance.toFixed(2)}</div>
                <p className="text-xs text-muted-foreground">Total available wallet balance</p>
              </CardContent>
            </Card>

            {/* Total Profit Balance */}
            <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-pink-500 bg-card backdrop-blur-xl border border-border">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-foreground">Users Profit Balance</CardTitle>
                <TrendingUp className="h-4 w-4 text-pink-600" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold bg-gradient-to-r from-pink-600 to-rose-600 bg-clip-text text-transparent">GHS {stats.totalProfitBalance.toFixed(2)}</div>
                <p className="text-xs text-muted-foreground">Total available profit balance</p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Pending Approvals Alert */}
        {stats && stats.pendingShops > 0 && (
          <Card className="border-l-4 border-l-warning/30 bg-card backdrop-blur-xl border border-border">
            <CardContent className="pt-6 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <AlertCircle className="h-6 w-6 text-warning" />
                <div>
                  <p className="font-semibold text-foreground">{formatCount(stats.pendingShops)} Pending Shop Approval{stats.pendingShops !== 1 ? "s" : ""}</p>
                  <p className="text-sm text-muted-foreground">There are shops waiting for approval</p>
                </div>
              </div>
              <Button
                onClick={() => handleNavigate("/admin/shops")}
                disabled={navigating !== null}
                className="bg-warning hover:bg-warning/90"
              >
                {navigating === "/admin/shops" ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Loading...
                  </>
                ) : (
                  "Review Now"
                )}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Management Sections */}
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 lg:gap-6">
          {/* Package Management */}
          <Card className="hover:shadow-2xl transition-all duration-300 cursor-pointer group bg-card backdrop-blur-xl border border-primary/20 hover:border-border">
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-gradient-to-br from-blue-400/30 to-primary/20 backdrop-blur p-2 rounded-lg border border-border">
                  <Package className="h-5 w-5 text-primary" />
                </div>
                <CardTitle>Manage Packages</CardTitle>
              </div>
              <CardDescription>Add, edit, or delete data packages</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => handleNavigate("/admin/packages")}
                disabled={navigating !== null}
                className="w-full bg-gradient-to-r from-primary to-primary hover:from-primary hover:to-primary text-primary-foreground font-semibold"
              >
                {navigating === "/admin/packages" ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Loading...
                  </>
                ) : (
                  "Go to Packages"
                )}
              </Button>
            </CardContent>
          </Card>

          {/* User Management */}
          <Card className="hover:shadow-2xl transition-all duration-300 cursor-pointer group bg-card backdrop-blur-xl border border-border hover:border-border">
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-success/15 backdrop-blur p-2 rounded-lg border border-border">
                  <Users className="h-5 w-5 text-success" />
                </div>
                <CardTitle>Manage Users</CardTitle>
              </div>
              <CardDescription>View users, manage balance and roles</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => handleNavigate("/admin/users")}
                disabled={navigating !== null}
                className="w-full bg-success hover:bg-success/90 text-primary-foreground font-semibold"
              >
                {navigating === "/admin/users" ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Loading...
                  </>
                ) : (
                  "Go to Users"
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Order Management */}
          <Card className="hover:shadow-2xl transition-all duration-300 cursor-pointer group bg-card backdrop-blur-xl border border-border hover:border-border">
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-warning/15 backdrop-blur p-2 rounded-lg border border-border">
                  <Download className="h-5 w-5 text-warning" />
                </div>
                <CardTitle>Order Management</CardTitle>
              </div>
              <CardDescription>Download and manage orders</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => handleNavigate("/admin/orders")}
                disabled={navigating !== null}
                className="w-full bg-warning hover:bg-warning/90 text-primary-foreground font-semibold"
              >
                {navigating === "/admin/orders" ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Loading...
                  </>
                ) : (
                  "Go to Orders"
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Order Payment Status */}
          <Card className="hover:shadow-2xl transition-all duration-300 cursor-pointer group bg-card backdrop-blur-xl border border-border hover:border-border">
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-gradient-to-br from-primary/30 to-blue-400/20 backdrop-blur p-2 rounded-lg border border-border">
                  <Search className="h-5 w-5 text-primary" />
                </div>
                <CardTitle>Order Payment Status</CardTitle>
              </div>
              <CardDescription>Search and view all order payments</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => handleNavigate("/admin/order-payment-status")}
                disabled={navigating !== null}
                className="w-full bg-gradient-to-r from-primary to-primary/80 hover:from-primary hover:to-primary/80 text-primary-foreground font-semibold"
              >
                {navigating === "/admin/order-payment-status" ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Loading...
                  </>
                ) : (
                  "Go to Payment Status"
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Shop Approvals */}
          <Card className="hover:shadow-2xl transition-all duration-300 cursor-pointer group bg-card backdrop-blur-xl border border-border hover:border-border">
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-gradient-to-br from-primary/30 to-primary/20 backdrop-blur p-2 rounded-lg border border-border">
                  <Store className="h-5 w-5 text-primary" />
                </div>
                <CardTitle>Shop Approvals</CardTitle>
              </div>
              <CardDescription>Approve or reject shop creations</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => handleNavigate("/admin/shops")}
                disabled={navigating !== null}
                className="w-full bg-gradient-to-r from-primary to-primary hover:from-primary hover:to-primary text-primary-foreground font-semibold"
              >
                {navigating === "/admin/shops" ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Loading...
                  </>
                ) : (
                  "Go to Shops"
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Withdrawal Approvals */}
          <Card className="hover:shadow-2xl transition-all duration-300 cursor-pointer group bg-card backdrop-blur-xl border border-border hover:border-border">
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-warning/15 backdrop-blur p-2 rounded-lg border border-border">
                  <Wallet className="h-5 w-5 text-warning" />
                </div>
                <CardTitle>Withdrawal Approvals</CardTitle>
              </div>
              <CardDescription>Review and approve shop withdrawals</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => handleNavigate("/admin/withdrawals")}
                disabled={navigating !== null}
                className="w-full bg-warning hover:bg-warning/90 text-primary-foreground font-semibold"
              >
                {navigating === "/admin/withdrawals" ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Loading...
                  </>
                ) : (
                  "Go to Withdrawals"
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Profits History */}
          <Card className="hover:shadow-2xl transition-all duration-300 cursor-pointer group bg-card backdrop-blur-xl border border-border hover:border-border">
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-success/15 backdrop-blur p-2 rounded-lg border border-border">
                  <Banknote className="h-5 w-5 text-success" />
                </div>
                <CardTitle>Profits History</CardTitle>
              </div>
              <CardDescription>Track all shop profits crediting</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => handleNavigate("/admin/profits-history")}
                disabled={navigating !== null}
                className="w-full bg-success hover:bg-success/90 text-primary-foreground font-semibold"
              >
                {navigating === "/admin/profits-history" ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Loading...
                  </>
                ) : (
                  "View Profits"
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Order History */}
          <Card className="hover:shadow-2xl transition-all duration-300 cursor-pointer group bg-card backdrop-blur-xl border border-border hover:border-border">
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-gradient-to-br from-primary/30 to-primary/20 backdrop-blur p-2 rounded-lg border border-border">
                  <TrendingUp className="h-5 w-5 text-primary" />
                </div>
                <CardTitle>Order History</CardTitle>
              </div>
              <CardDescription>View completed order stats and history</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => handleNavigate("/admin/order-history")}
                disabled={navigating !== null}
                className="w-full bg-gradient-to-r from-primary to-primary hover:from-primary hover:to-primary text-primary-foreground font-semibold"
              >
                {navigating === "/admin/order-history" ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Loading...
                  </>
                ) : (
                  "View Order History"
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Sub-Agent Profits */}
          <Card className="hover:shadow-2xl transition-all duration-300 cursor-pointer group bg-card backdrop-blur-xl border border-border hover:border-border">
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-gradient-to-br from-primary/30 to-primary/20 backdrop-blur p-2 rounded-lg border border-border">
                  <TrendingUp className="h-5 w-5 text-primary" />
                </div>
                <CardTitle>Sub-Agent Profits</CardTitle>
              </div>
              <CardDescription>View parent shops and sub-agent profit contributions</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => handleNavigate("/admin/sub-agent-profits")}
                disabled={navigating !== null}
                className="w-full bg-gradient-to-r from-primary to-primary hover:from-primary hover:to-primary text-primary-foreground font-semibold"
              >
                {navigating === "/admin/sub-agent-profits" ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Loading...
                  </>
                ) : (
                  "View Sub-Agent Profits"
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Dealer Subscriptions Management */}
          <Card className="hover:shadow-2xl transition-all duration-300 cursor-pointer group bg-card backdrop-blur-xl border border-border hover:border-border">
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-warning/15 backdrop-blur p-2 rounded-lg border border-border">
                  <Crown className="h-5 w-5 text-warning" />
                </div>
                <CardTitle>Dealer Subscriptions</CardTitle>
              </div>
              <CardDescription>Monitor active and expired dealer plans</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => handleNavigate("/admin/subscribers")}
                disabled={navigating !== null}
                className="w-full bg-warning hover:bg-warning/90 text-primary-foreground font-semibold"
              >
                {navigating === "/admin/subscribers" ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Loading...
                  </>
                ) : (
                  "Monitor Subscribers"
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Complaints Management */}
          <Card className="hover:shadow-2xl transition-all duration-300 cursor-pointer group bg-card backdrop-blur-xl border border-border hover:border-border">
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-destructive/15 backdrop-blur p-2 rounded-lg border border-border">
                  <MessageSquare className="h-5 w-5 text-destructive" />
                </div>
                <CardTitle>Customer Complaints</CardTitle>
              </div>
              <CardDescription>View and resolve customer complaints</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => handleNavigate("/admin/complaints")}
                disabled={navigating !== null}
                className="w-full bg-destructive hover:bg-destructive/90 text-primary-foreground font-semibold"
              >
                {navigating === "/admin/complaints" ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Loading...
                  </>
                ) : (
                  "Go to Complaints"
                )}
              </Button>
            </CardContent>
          </Card>

          {/* AFA Management */}
          <Card className="hover:shadow-2xl transition-all duration-300 cursor-pointer group bg-card backdrop-blur-xl border border-border hover:border-border">
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-gradient-to-br from-primary/30 to-blue-400/20 backdrop-blur p-2 rounded-lg border border-border">
                  <Settings className="h-5 w-5 text-primary" />
                </div>
                <CardTitle>AFA Management</CardTitle>
              </div>
              <CardDescription>Configure AFA price and view submissions</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => handleNavigate("/admin/afa-management")}
                disabled={navigating !== null}
                className="w-full bg-gradient-to-r from-primary to-primary/80 hover:from-primary hover:to-primary/80 text-primary-foreground font-semibold"
              >
                {navigating === "/admin/afa-management" ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Loading...
                  </>
                ) : (
                  "Go to AFA Settings"
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Broadcast Messaging */}
          <Card className="hover:shadow-2xl transition-all duration-300 cursor-pointer group bg-card backdrop-blur-xl border border-border hover:border-border">
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-gradient-to-br from-pink-400/30 to-rose-400/20 backdrop-blur p-2 rounded-lg border border-border">
                  <Send className="h-5 w-5 text-pink-600" />
                </div>
                <CardTitle>Broadcast Messaging</CardTitle>
              </div>
              <CardDescription>Send bulk SMS and Emails to users</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => handleNavigate("/admin/broadcast")}
                disabled={navigating !== null}
                className="w-full bg-gradient-to-r from-pink-600 to-rose-600 hover:from-pink-700 hover:to-rose-700 text-primary-foreground font-semibold"
              >
                {navigating === "/admin/broadcast" ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Loading...
                  </>
                ) : (
                  "Go to Messaging"
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Airtime Orders */}
          <Card className="hover:shadow-2xl transition-all duration-300 cursor-pointer group bg-card backdrop-blur-xl border border-border hover:border-border">
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-warning/15 backdrop-blur p-2 rounded-lg border border-border">
                  <Banknote className="h-5 w-5 text-warning" />
                </div>
                <CardTitle>Airtime Orders</CardTitle>
              </div>
              <CardDescription>Manage and fulfil airtime top-up orders</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => handleNavigate("/admin/airtime")}
                disabled={navigating !== null}
                className="w-full bg-warning hover:bg-warning/90 text-primary-foreground font-semibold"
              >
                {navigating === "/admin/airtime" ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Loading...
                  </>
                ) : (
                  "Manage Airtime"
                )}
              </Button>
            </CardContent>
          </Card>
        </div>


        {/* Success Metrics */}
        {stats && (
          <Card className="bg-card backdrop-blur-xl border border-border hover:border-border hover:shadow-2xl transition-all duration-300">
            <CardHeader>
              <CardTitle>Platform Metrics</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 md:grid-cols-3 gap-6">
              <div>
                <p className="text-sm text-muted-foreground mb-1">Completed Orders</p>
                <p className="text-2xl font-bold text-primary">{formatCount(stats.completedOrders)}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground mb-1">Success Rate</p>
                <p className="text-2xl font-bold text-success">{stats.successRate}%</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground mb-1">Pending Approvals</p>
                <Badge className="bg-warning">{stats.pendingShops}</Badge>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  )
}
