"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Users, Package, Store, TrendingUp, AlertCircle, Download, Wallet, Loader2 } from "lucide-react"
import { useAdminProtected } from "@/hooks/use-admin"
import { adminDashboardService } from "@/lib/admin-service"
import { toast } from "sonner"

interface DashboardStats {
  totalUsers: number
  totalShops: number
  totalOrders: number
  totalRevenue: number
  pendingShops: number
  completedOrders: number
  successRate: string | number
}

export default function AdminDashboardPage() {
  const router = useRouter()
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (isAdmin && !adminLoading) {
      loadStats()
    }
  }, [isAdmin, adminLoading])

  const loadStats = async () => {
    try {
      const dashboardStats = await adminDashboardService.getDashboardStats()
      setStats(dashboardStats)
    } catch (error) {
      console.error("Error loading stats:", error)
      toast.error("Failed to load dashboard stats")
    } finally {
      setLoading(false)
    }
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
          <h1 className="text-4xl font-bold bg-gradient-to-r from-red-600 via-purple-600 to-pink-600 bg-clip-text text-transparent">Admin Dashboard</h1>
          <p className="text-gray-500 mt-1 font-medium">Manage packages, users, and shop approvals</p>
        </div>

        {/* Stats Cards */}
        {stats && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Total Users */}
            <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-blue-500 bg-gradient-to-br from-blue-50/60 to-cyan-50/40 backdrop-blur-xl border border-blue-200/40">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-gray-900">Total Users</CardTitle>
                <Users className="h-4 w-4 text-blue-600" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold bg-gradient-to-r from-blue-600 to-cyan-600 bg-clip-text text-transparent">{stats.totalUsers}</div>
                <p className="text-xs text-gray-500">Registered users</p>
              </CardContent>
            </Card>

            {/* Total Shops */}
            <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-emerald-500 bg-gradient-to-br from-emerald-50/60 to-teal-50/40 backdrop-blur-xl border border-emerald-200/40">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-gray-900">Total Shops</CardTitle>
                <Store className="h-4 w-4 text-emerald-600" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold bg-gradient-to-r from-emerald-600 to-teal-600 bg-clip-text text-transparent">{stats.totalShops}</div>
                <p className="text-xs text-gray-500">Active shops</p>
              </CardContent>
            </Card>

            {/* Total Orders */}
            <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-amber-500 bg-gradient-to-br from-amber-50/60 to-orange-50/40 backdrop-blur-xl border border-amber-200/40">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-gray-900">Total Orders</CardTitle>
                <Package className="h-4 w-4 text-amber-600" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold bg-gradient-to-r from-amber-600 to-orange-600 bg-clip-text text-transparent">{stats.totalOrders}</div>
                <p className="text-xs text-gray-500">All time orders</p>
              </CardContent>
            </Card>

            {/* Total Revenue */}
            <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-violet-500 bg-gradient-to-br from-violet-50/60 to-purple-50/40 backdrop-blur-xl border border-violet-200/40">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-gray-900">Total Revenue</CardTitle>
                <TrendingUp className="h-4 w-4 text-violet-600" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold bg-gradient-to-r from-violet-600 to-purple-600 bg-clip-text text-transparent">GHS {stats.totalRevenue.toFixed(2)}</div>
                <p className="text-xs text-gray-500">Platform revenue</p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Pending Approvals Alert */}
        {stats && stats.pendingShops > 0 && (
          <Card className="border-l-4 border-l-orange-500 bg-gradient-to-br from-orange-50/60 to-red-50/40 backdrop-blur-xl border border-orange-200/40">
            <CardContent className="pt-6 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <AlertCircle className="h-6 w-6 text-orange-600" />
                <div>
                  <p className="font-semibold text-gray-900">{stats.pendingShops} Pending Shop Approval{stats.pendingShops !== 1 ? "s" : ""}</p>
                  <p className="text-sm text-gray-600">There are shops waiting for approval</p>
                </div>
              </div>
              <Button
                onClick={() => router.push("/admin/shops")}
                className="bg-gradient-to-r from-orange-600 to-red-600 hover:from-orange-700 hover:to-red-700"
              >
                Review Now
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Management Sections */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {/* Package Management */}
          <Card className="hover:shadow-2xl transition-all duration-300 cursor-pointer group bg-gradient-to-br from-blue-50/60 to-cyan-50/40 backdrop-blur-xl border border-blue-200/40 hover:border-blue-300/60">
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-gradient-to-br from-blue-400/30 to-cyan-400/20 backdrop-blur p-2 rounded-lg border border-blue-300/60">
                  <Package className="h-5 w-5 text-blue-600" />
                </div>
                <CardTitle>Manage Packages</CardTitle>
              </div>
              <CardDescription>Add, edit, or delete data packages</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => router.push("/admin/packages")}
                className="w-full bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white font-semibold"
              >
                Go to Packages
              </Button>
            </CardContent>
          </Card>

          {/* User Management */}
          <Card className="hover:shadow-2xl transition-all duration-300 cursor-pointer group bg-gradient-to-br from-emerald-50/60 to-teal-50/40 backdrop-blur-xl border border-emerald-200/40 hover:border-emerald-300/60">
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-gradient-to-br from-emerald-400/30 to-teal-400/20 backdrop-blur p-2 rounded-lg border border-emerald-300/60">
                  <Users className="h-5 w-5 text-emerald-600" />
                </div>
                <CardTitle>Manage Users</CardTitle>
              </div>
              <CardDescription>View users, manage balance and roles</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => router.push("/admin/users")}
                className="w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold"
              >
                Go to Users
              </Button>
            </CardContent>
          </Card>

          {/* Order Management */}
          <Card className="hover:shadow-2xl transition-all duration-300 cursor-pointer group bg-gradient-to-br from-orange-50/60 to-amber-50/40 backdrop-blur-xl border border-orange-200/40 hover:border-orange-300/60">
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-gradient-to-br from-orange-400/30 to-amber-400/20 backdrop-blur p-2 rounded-lg border border-orange-300/60">
                  <Download className="h-5 w-5 text-orange-600" />
                </div>
                <CardTitle>Order Management</CardTitle>
              </div>
              <CardDescription>Download and manage orders</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => router.push("/admin/orders")}
                className="w-full bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-700 hover:to-amber-700 text-white font-semibold"
              >
                Go to Orders
              </Button>
            </CardContent>
          </Card>

          {/* Shop Approvals */}
          <Card className="hover:shadow-2xl transition-all duration-300 cursor-pointer group bg-gradient-to-br from-violet-50/60 to-purple-50/40 backdrop-blur-xl border border-violet-200/40 hover:border-violet-300/60">
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-gradient-to-br from-violet-400/30 to-purple-400/20 backdrop-blur p-2 rounded-lg border border-violet-300/60">
                  <Store className="h-5 w-5 text-violet-600" />
                </div>
                <CardTitle>Shop Approvals</CardTitle>
              </div>
              <CardDescription>Approve or reject shop creations</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => router.push("/admin/shops")}
                className="w-full bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 text-white font-semibold"
              >
                Go to Shops
              </Button>
            </CardContent>
          </Card>

          {/* Withdrawal Approvals */}
          <Card className="hover:shadow-2xl transition-all duration-300 cursor-pointer group bg-gradient-to-br from-amber-50/60 to-yellow-50/40 backdrop-blur-xl border border-amber-200/40 hover:border-amber-300/60">
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-gradient-to-br from-amber-400/30 to-yellow-400/20 backdrop-blur p-2 rounded-lg border border-amber-300/60">
                  <Wallet className="h-5 w-5 text-amber-600" />
                </div>
                <CardTitle>Withdrawal Approvals</CardTitle>
              </div>
              <CardDescription>Review and approve shop withdrawals</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => router.push("/admin/withdrawals")}
                className="w-full bg-gradient-to-r from-amber-600 to-yellow-600 hover:from-amber-700 hover:to-yellow-700 text-white font-semibold"
              >
                Go to Withdrawals
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Success Metrics */}
        {stats && (
          <Card className="bg-gradient-to-br from-indigo-50/60 to-blue-50/40 backdrop-blur-xl border border-indigo-200/40 hover:border-indigo-300/60 hover:shadow-2xl transition-all duration-300">
            <CardHeader>
              <CardTitle>Platform Metrics</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 md:grid-cols-3 gap-6">
              <div>
                <p className="text-sm text-gray-600 mb-1">Completed Orders</p>
                <p className="text-2xl font-bold text-indigo-600">{stats.completedOrders}</p>
              </div>
              <div>
                <p className="text-sm text-gray-600 mb-1">Success Rate</p>
                <p className="text-2xl font-bold text-emerald-600">{stats.successRate}%</p>
              </div>
              <div>
                <p className="text-sm text-gray-600 mb-1">Pending Approvals</p>
                <Badge className="bg-orange-600">{stats.pendingShops}</Badge>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  )
}
