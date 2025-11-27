"use client"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ShoppingCart, CheckCircle, Clock, AlertCircle, Loader2 } from "lucide-react"
import { useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

interface OrderStats {
  totalOrders: number
  completed: number
  processing: number
  failed: number
  pending: number
  successRate: number
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

export default function MyOrdersPage() {
  const [stats, setStats] = useState<OrderStats>({
    totalOrders: 0,
    completed: 0,
    processing: 0,
    failed: 0,
    pending: 0,
    successRate: 0,
  })
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({
    network: "all",
    status: "all",
    dateRange: "all",
  })
  const [page, setPage] = useState(1)
  const pageSize = 10

  useEffect(() => {
    fetchOrdersData()
  }, [filters, page])

  const fetchOrdersData = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return

      // Fetch stats
      const statsResponse = await fetch("/api/orders/stats", {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })
      if (statsResponse.ok) {
        const statsData = await statsResponse.json()
        setStats(statsData)
      }

      // Fetch orders list
      const queryParams = new URLSearchParams()
      queryParams.append("page", page.toString())
      queryParams.append("limit", pageSize.toString())
      if (filters.network !== "all") queryParams.append("network", filters.network)
      if (filters.status !== "all") queryParams.append("status", filters.status)
      if (filters.dateRange !== "all") queryParams.append("dateRange", filters.dateRange)

      const ordersResponse = await fetch(`/api/orders/list?${queryParams.toString()}`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })
      if (ordersResponse.ok) {
        const ordersData = await ordersResponse.json()
        setOrders(ordersData.orders || [])
      }
    } catch (error) {
      console.error("Error fetching orders data:", error)
      toast.error("Failed to load orders")
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-screen">
          <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
        </div>
      </DashboardLayout>
    )
  }

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case "completed":
        return "bg-green-100 text-green-800"
      case "processing":
        return "bg-yellow-100 text-yellow-800"
      case "failed":
        return "bg-red-100 text-red-800"
      case "placed":
        return "bg-blue-100 text-blue-800"
      default:
        return "bg-gray-100 text-gray-800"
    }
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div>
          <h1 className="text-3xl font-bold text-gray-900">My Orders</h1>
          <p className="text-gray-600 mt-1">Track and manage your data package orders</p>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Orders</CardTitle>
              <ShoppingCart className="h-4 w-4 text-blue-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.totalOrders.toLocaleString()}</div>
              <p className="text-xs text-gray-600">All time</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Completed</CardTitle>
              <CheckCircle className="h-4 w-4 text-green-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.completed.toLocaleString()}</div>
              <p className="text-xs text-gray-600">{stats.successRate.toFixed(1)}% success</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Processing</CardTitle>
              <Clock className="h-4 w-4 text-yellow-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.processing}</div>
              <p className="text-xs text-gray-600">In progress</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Failed</CardTitle>
              <AlertCircle className="h-4 w-4 text-red-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.failed}</div>
              <p className="text-xs text-gray-600">No failures</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending</CardTitle>
              <Clock className="h-4 w-4 text-indigo-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.pending}</div>
              <p className="text-xs text-gray-600">Awaiting processing</p>
            </CardContent>
          </Card>
        </div>

        {/* Filters Card */}
        <Card>
          <CardHeader>
            <CardTitle>Filters</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label htmlFor="network" className="text-sm font-medium text-gray-700">Network</label>
                <select 
                  id="network"
                  value={filters.network}
                  onChange={(e) => { setFilters({ ...filters, network: e.target.value }); setPage(1); }}
                  className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-md"
                >
                  <option value="all">All Networks</option>
                  <option value="MTN">MTN</option>
                  <option value="Telecel">Telecel</option>
                  <option value="AT">AT - iShare</option>
                </select>
              </div>
              <div>
                <label htmlFor="status" className="text-sm font-medium text-gray-700">Status</label>
                <select 
                  id="status"
                  value={filters.status}
                  onChange={(e) => { setFilters({ ...filters, status: e.target.value }); setPage(1); }}
                  className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-md"
                >
                  <option value="all">All Status</option>
                  <option value="placed">Placed</option>
                  <option value="processing">Processing</option>
                  <option value="completed">Completed</option>
                  <option value="failed">Failed</option>
                </select>
              </div>
              <div>
                <label htmlFor="dateRange" className="text-sm font-medium text-gray-700">Date Range</label>
                <select 
                  id="dateRange"
                  value={filters.dateRange}
                  onChange={(e) => { setFilters({ ...filters, dateRange: e.target.value }); setPage(1); }}
                  className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-md"
                >
                  <option value="all">All Time</option>
                  <option value="today">Today</option>
                  <option value="week">This Week</option>
                  <option value="month">This Month</option>
                  <option value="3months">Last 3 Months</option>
                </select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Orders Table */}
        <Card>
          <CardHeader>
            <CardTitle>Orders List</CardTitle>
            <CardDescription>{orders.length === 0 ? "No orders found" : `Showing ${orders.length} order(s)`}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Order Details</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Phone Number</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Amount</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Date</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Status</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-8 text-center text-gray-500">
                        No orders found. Start by purchasing a data package!
                      </td>
                    </tr>
                  ) : (
                    orders.map((order) => (
                      <tr key={order.id} className="hover:bg-gray-50 border-b">
                        <td className="px-6 py-4 text-sm">
                          <div>
                            <p className="font-medium">{order.package_name}</p>
                            <p className="text-xs text-gray-600">{order.network_name}</p>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-sm font-mono">{order.phone_number}</td>
                        <td className="px-6 py-4 text-sm font-semibold">GHS {order.total_price.toFixed(2)}</td>
                        <td className="px-6 py-4 text-sm">{new Date(order.created_at).toLocaleDateString()}</td>
                        <td className="px-6 py-4 text-sm">
                          <Badge className={getStatusBadgeColor(order.order_status)}>
                            {order.order_status.charAt(0).toUpperCase() + order.order_status.slice(1)}
                          </Badge>
                        </td>
                        <td className="px-6 py-4 text-sm">
                          <Button size="sm" variant="outline">View</Button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex justify-between items-center">
              <p className="text-sm text-gray-600">Showing {orders.length} result(s)</p>
              <div className="flex gap-2">
                <Button 
                  variant="outline" 
                  onClick={() => setPage(page - 1)}
                  disabled={page === 1}
                >
                  Previous
                </Button>
                <Button 
                  variant="outline"
                  onClick={() => setPage(page + 1)}
                  disabled={orders.length < pageSize}
                >
                  Next
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
