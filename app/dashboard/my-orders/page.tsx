"use client"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ShoppingCart, CheckCircle, Clock, AlertCircle, Loader2, MessageSquare } from "lucide-react"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Metadata } from "next"
import { useAuth } from "@/hooks/use-auth"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { ComplaintModal } from "@/components/complaint-modal"
import { Input } from "@/components/ui/input"
import { Search } from "lucide-react"

export const metadata: Metadata = {
  title: "My Orders | Track Your Purchases | DATAGOD",
  description: "View and track all your DATAGOD orders. Check delivery status, package details, and order history.",
  robots: {
    index: false,
    follow: true,
  },
  openGraph: {
    title: "My Orders | Track Your Purchases | DATAGOD",
    description: "Track all your DATAGOD data package and airtime orders.",
    type: "website",
    url: "https://www.datagod.store/dashboard/my-orders",
  },
};

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
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()
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
  const [searchPhone, setSearchPhone] = useState("")
  const [filters, setFilters] = useState({
    network: "all",
    status: "all",
    dateRange: "all",
  })
  const [page, setPage] = useState(1)
  const [complaintModalOpen, setComplaintModalOpen] = useState(false)
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const pageSize = 10

  // Auth protection
  useEffect(() => {
    if (!authLoading && !user) {
      console.log("[MY-ORDERS] User not authenticated, redirecting to login")
      router.push("/auth/login")
    }
  }, [user, authLoading, router])

  useEffect(() => {
    if (user) {
      fetchOrdersData()
    }
  }, [filters, page, user])

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
        // Sync pending count to localStorage for sidebar badge
        localStorage.setItem('userPendingOrdersCount', statsData.pending.toString())
        console.log('[MY-ORDERS] Updated localStorage with pending count:', statsData.pending)
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
      const errorMessage = error instanceof Error ? error.message : "Failed to load orders"
      toast.error(errorMessage)
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

  // Filter orders based on search criteria
  const filteredOrders = orders.filter((order) => {
    if (searchPhone.trim() === "") return true
    return order.phone_number && order.phone_number.includes(searchPhone.trim())
  })

  return (
    <DashboardLayout>
      <div className="space-y-6 px-2 sm:px-4">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">My Orders</h1>
          <p className="text-sm sm:text-base text-gray-600 mt-1">Track and manage your data package orders</p>
        </div>

        {/* Stats Cards */}
        <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Orders</CardTitle>
              <ShoppingCart className="h-4 w-4 text-blue-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatCount(stats.totalOrders)}</div>
              <p className="text-xs text-gray-600">All time</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Completed</CardTitle>
              <CheckCircle className="h-4 w-4 text-green-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatCount(stats.completed)}</div>
              <p className="text-xs text-gray-600">{stats.successRate.toFixed(1)}% success</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Processing</CardTitle>
              <Clock className="h-4 w-4 text-yellow-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatCount(stats.processing)}</div>
              <p className="text-xs text-gray-600">In progress</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Failed</CardTitle>
              <AlertCircle className="h-4 w-4 text-red-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatCount(stats.failed)}</div>
              <p className="text-xs text-gray-600">No failures</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending</CardTitle>
              <Clock className="h-4 w-4 text-indigo-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatCount(stats.pending)}</div>
              <p className="text-xs text-gray-600">Awaiting processing</p>
            </CardContent>
          </Card>
        </div>

        {/* Filters Card */}
        <Card>
          <CardHeader>
            <CardTitle>Filters & Search</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Search by Phone Number */}
            <div>
              <label htmlFor="searchPhone" className="text-sm font-medium text-gray-700">Search by Phone Number</label>
              <div className="relative mt-1">
                <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                <Input
                  id="searchPhone"
                  type="text"
                  placeholder="Enter phone number (e.g., 0201234567)"
                  value={searchPhone}
                  onChange={(e) => setSearchPhone(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 sm:gap-3 lg:gap-4">
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
                  <option value="AT - iShare">AT - iShare</option>
                  <option value="AT - BigTime">AT - BigTime</option>
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
            <CardDescription>{filteredOrders.length === 0 ? "No orders found" : `Showing ${filteredOrders.length} order(s)`}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-md border border-gray-100">
              <table className="min-w-[700px] w-full text-xs sm:text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold text-gray-900">Order Details</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-900">Phone Number</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-900">Amount</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-900">Date</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-900">Status</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-900">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredOrders.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                        {searchPhone.trim() ? "No orders found matching your search." : "No orders found. Start by purchasing a data package!"}
                      </td>
                    </tr>
                  ) : (
                    filteredOrders.map((order) => (
                      <tr key={order.id} className="hover:bg-gray-50 border-b">
                        <td className="px-4 py-3">
                          <div>
                            <p className="font-medium">{order.package_name}</p>
                            <p className="text-xs text-gray-600">{order.network_name}</p>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono">{order.phone_number}</td>
                        <td className="px-4 py-3 font-semibold">GHS {(order.total_price || 0).toFixed(2)}</td>
                        <td className="px-4 py-3">
                          <div>{new Date(order.created_at).toLocaleDateString()}</div>
                          <div className="text-xs text-gray-500">{new Date(order.created_at).toLocaleTimeString()}</div>
                        </td>
                        <td className="px-4 py-3">
                          <Badge className={getStatusBadgeColor(order.order_status)}>
                            {order.order_status.charAt(0).toUpperCase() + order.order_status.slice(1)}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <Button size="sm" variant="outline">View</Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setSelectedOrder(order)
                                setComplaintModalOpen(true)
                              }}
                              className="gap-1"
                              title="File a complaint for this order"
                            >
                              <MessageSquare className="w-4 h-4" />
                              Complain
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex justify-between items-center">
              <p className="text-sm text-gray-600">Showing {filteredOrders.length} result(s)</p>
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
                  disabled={filteredOrders.length < pageSize}
                >
                  Next
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
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
