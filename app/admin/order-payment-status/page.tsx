"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Input } from "@/components/ui/input"
import { AlertCircle, Loader2, Search, Edit } from "lucide-react"
import { useAdminProtected } from "@/hooks/use-admin"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"

interface AllOrder {
  id: string
  type: string
  phone_number: string
  network: string
  volume_gb: number
  price: number
  status: string
  payment_status: string
  payment_reference: string
  created_at: string
}

function getNetworkColor(network: string): string {
  const colorMap: { [key: string]: string } = {
    "MTN": "bg-yellow-100 text-yellow-800",
    "Telecel": "bg-purple-100 text-purple-800",
    "AT - iShare": "bg-blue-100 text-blue-800",
    "AT - BigTime": "bg-green-100 text-green-800",
    "iShare": "bg-blue-100 text-blue-800",
  }
  return colorMap[network] || "bg-gray-100 text-gray-800"
}

export default function OrderPaymentStatusPage() {
  const router = useRouter()
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  
  const [allOrders, setAllOrders] = useState<AllOrder[]>([])
  const [loadingAllOrders, setLoadingAllOrders] = useState(false)
  const [updatingOrderId, setUpdatingOrderId] = useState<string | null>(null)
  
  const [searchQuery, setSearchQuery] = useState("")
  const [searchType, setSearchType] = useState<"all" | "reference" | "phone">("all")

  useEffect(() => {
    if (isAdmin && !adminLoading) {
      loadAllOrders()
    }
  }, [isAdmin, adminLoading])

  useEffect(() => {
    if (isAdmin) {
      loadAllOrders()
    }
  }, [searchQuery, searchType, isAdmin])

  const loadAllOrders = async () => {
    try {
      setLoadingAllOrders(true)
      console.log("Fetching all orders with search...")
      
      const params = new URLSearchParams()
      if (searchQuery) {
        params.append("search", searchQuery)
        params.append("searchType", searchType)
      }
      
      const response = await fetch(`/api/admin/orders/all?${params.toString()}`)
      
      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || "Failed to load all orders")
      }

      const result = await response.json()
      console.log("Fetched all orders:", result.count)
      setAllOrders(result.data || [])
    } catch (error) {
      console.error("Error loading all orders:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to load all orders"
      toast.error(errorMessage)
    } finally {
      setLoadingAllOrders(false)
    }
  }

  const handleStatusUpdate = async (orderId: string, orderType: string, newStatus: string) => {
    if (!newStatus) return
    
    try {
      setUpdatingOrderId(orderId)
      
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Authentication required")
        return
      }

      const response = await fetch("/api/admin/orders/bulk-update-status", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          orderIds: [orderId],
          status: newStatus,
          orderType: orderType === "shop" ? "shop" : "bulk"
        })
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || "Failed to update status")
      }

      toast.success(`Order status updated to ${newStatus}`)
      
      // Update local state
      setAllOrders(prev => prev.map(order => 
        order.id === orderId ? { ...order, status: newStatus } : order
      ))
    } catch (error) {
      console.error("Error updating order status:", error)
      toast.error(error instanceof Error ? error.message : "Failed to update status")
    } finally {
      setUpdatingOrderId(null)
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
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold bg-gradient-to-r from-blue-600 via-purple-600 to-pink-600 bg-clip-text text-transparent">
            Order Payment Status
          </h1>
          <p className="text-gray-500 mt-1 font-medium">View and search all orders by payment reference or phone number</p>
        </div>

        {/* Search Card */}
        <Card>
          <CardHeader>
            <CardTitle>Search Orders</CardTitle>
            <CardDescription>Search by payment reference or phone number</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2 items-end flex-wrap">
              <div className="flex-1 min-w-64">
                <label className="text-sm font-medium mb-1 block">Search Query</label>
                <div className="relative">
                  <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                  <Input
                    placeholder="Enter payment reference or phone number..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>
              <div className="w-48">
                <label className="text-sm font-medium mb-1 block">Search Type</label>
                <select
                  value={searchType}
                  onChange={(e) => setSearchType(e.target.value as "all" | "reference" | "phone")}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="all">All Fields</option>
                  <option value="reference">Payment Reference</option>
                  <option value="phone">Phone Number</option>
                </select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Orders Results */}
        {loadingAllOrders ? (
          <Card>
            <CardContent className="pt-6 flex justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
            </CardContent>
          </Card>
        ) : allOrders.length === 0 ? (
          <Card>
            <CardContent className="pt-6">
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  {searchQuery ? "No orders found matching your search criteria" : "No orders available"}
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Order Results</CardTitle>
              <CardDescription>
                Showing {allOrders.length} order{allOrders.length !== 1 ? "s" : ""}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="px-4 py-2 text-left font-semibold text-gray-700">Type</th>
                      <th className="px-4 py-2 text-left font-semibold text-gray-700">Reference</th>
                      <th className="px-4 py-2 text-left font-semibold text-gray-700">Phone</th>
                      <th className="px-4 py-2 text-left font-semibold text-gray-700">Network</th>
                      <th className="px-4 py-2 text-left font-semibold text-gray-700">Volume</th>
                      <th className="px-4 py-2 text-right font-semibold text-gray-700">Price (GHS)</th>
                      <th className="px-4 py-2 text-center font-semibold text-gray-700">Payment Status</th>
                      <th className="px-4 py-2 text-center font-semibold text-gray-700">Order Status</th>
                      <th className="px-4 py-2 text-center font-semibold text-gray-700">Date</th>
                      <th className="px-4 py-2 text-center font-semibold text-gray-700">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {allOrders.map((order) => (
                      <tr key={order.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <Badge variant="outline" className="text-xs">
                            {order.type === "bulk" ? "Bulk" : order.type === "shop" ? "Shop" : "Wallet"}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs max-w-xs truncate" title={order.payment_reference}>
                          {order.payment_reference}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">{order.phone_number}</td>
                        <td className="px-4 py-3">
                          <Badge className={`${getNetworkColor(order.network)} border`}>
                            {order.network}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">{order.volume_gb}GB</td>
                        <td className="px-4 py-3 text-right font-semibold">₵ {order.price.toFixed(2)}</td>
                        <td className="px-4 py-3 text-center">
                          <Badge
                            className={`text-xs border ${
                              order.payment_status === "completed"
                                ? "bg-green-100 text-green-800 border-green-200"
                                : order.payment_status === "pending"
                                ? "bg-yellow-100 text-yellow-800 border-yellow-200"
                                : order.payment_status === "failed"
                                ? "bg-red-100 text-red-800 border-red-200"
                                : "bg-gray-100 text-gray-800 border-gray-200"
                            }`}
                          >
                            {order.payment_status?.charAt(0).toUpperCase() + order.payment_status?.slice(1) || "Unknown"}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <Badge
                            className={`text-xs border ${
                              order.status === "completed"
                                ? "bg-green-100 text-green-800 border-green-200"
                                : order.status === "pending"
                                ? "bg-yellow-100 text-yellow-800 border-yellow-200"
                                : order.status === "processing"
                                ? "bg-blue-100 text-blue-800 border-blue-200"
                                : "bg-red-100 text-red-800 border-red-200"
                            }`}
                          >
                            {order.status?.charAt(0).toUpperCase() + order.status?.slice(1) || "Unknown"}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-center text-xs text-gray-500">
                          <div>{new Date(order.created_at).toLocaleDateString()}</div>
                          <div className="text-xs text-gray-400">{new Date(order.created_at).toLocaleTimeString()}</div>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <select
                            className="px-2 py-1 text-xs border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                            onChange={(e) => handleStatusUpdate(order.id, order.type, e.target.value)}
                            disabled={updatingOrderId === order.id}
                            defaultValue=""
                            aria-label="Update order status"
                          >
                            <option value="">{updatingOrderId === order.id ? "Updating..." : "Update Status"}</option>
                            <option value="pending">Pending</option>
                            <option value="processing">Processing</option>
                            <option value="completed">Completed</option>
                            <option value="failed">Failed</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  )
}
