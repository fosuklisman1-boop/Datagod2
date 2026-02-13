"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Input } from "@/components/ui/input"
import { AlertCircle, Loader2, Search, Edit, Zap, Download } from "lucide-react"
import { useAdminProtected } from "@/hooks/use-admin"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"
import { Button } from "@/components/ui/button"

interface AllOrder {
  id: string
  type: string
  phone_number: string
  customer_email?: string
  shop_owner_email?: string
  store_name?: string
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
  const [fulfillingOrderId, setFulfillingOrderId] = useState<string | null>(null)
  const [autoFulfillmentEnabled, setAutoFulfillmentEnabled] = useState(false)

  const [searchQuery, setSearchQuery] = useState("")
  const [searchType, setSearchType] = useState<"all" | "reference" | "phone">("all")

  // Pagination state
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [totalOrdersCount, setTotalOrdersCount] = useState(0)
  const PAGE_SIZE = 50

  // Bulk update state
  const [showBulkUpdate, setShowBulkUpdate] = useState(false)
  const [bulkDate, setBulkDate] = useState("")
  const [bulkStartTime, setBulkStartTime] = useState("")
  const [bulkEndTime, setBulkEndTime] = useState("")
  const [bulkNetwork, setBulkNetwork] = useState("")
  const [bulkStatus, setBulkStatus] = useState("")
  const [bulkUpdating, setBulkUpdating] = useState(false)
  const [bulkDownloading, setBulkDownloading] = useState(false)
  const [globalBulkCount, setGlobalBulkCount] = useState<number | null>(null)
  const [loadingBulkCount, setLoadingBulkCount] = useState(false)

  useEffect(() => {
    if (isAdmin && !adminLoading) {
      loadAutoFulfillmentSetting()
      // Initial load or search reset
      setOffset(0)
      loadAllOrders(0, false)
    }
  }, [searchQuery, searchType, isAdmin, adminLoading, bulkDate, bulkNetwork, bulkStartTime, bulkEndTime])

  // Fetch global count for bulk operations when filters change
  useEffect(() => {
    if (showBulkUpdate && bulkDate) {
      fetchGlobalBulkCount()
    } else {
      setGlobalBulkCount(null)
    }
  }, [showBulkUpdate, bulkDate, bulkStartTime, bulkEndTime, bulkNetwork])

  const fetchGlobalBulkCount = async () => {
    if (!bulkDate) return

    try {
      setLoadingBulkCount(true)
      const params = new URLSearchParams()
      params.append("limit", "1")
      params.append("offset", "0")
      params.append("date", bulkDate)

      if (bulkNetwork && bulkNetwork !== "all") {
        params.append("network", bulkNetwork)
      }

      if (bulkStartTime) {
        params.append("startTime", bulkStartTime)
      }

      if (bulkEndTime) {
        params.append("endTime", bulkEndTime)
      }

      // Bulk operations typically target pending/processing orders
      params.append("status", "pending,processing")

      const response = await fetch(`/api/admin/orders/all?${params.toString()}`)
      if (response.ok) {
        const result = await response.json()
        setGlobalBulkCount(result.count || 0)
      }
    } catch (error) {
      console.error("Error fetching bulk count:", error)
    } finally {
      setLoadingBulkCount(false)
    }
  }

  const loadAutoFulfillmentSetting = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        console.error("[PAYMENT-STATUS] No session token available")
        return
      }

      const response = await fetch("/api/admin/settings/mtn-auto-fulfillment", {
        headers: {
          "Authorization": `Bearer ${session.access_token}`,
        }
      })
      if (response.ok) {
        const data = await response.json()
        console.log("[PAYMENT-STATUS] Auto-fulfillment setting response:", data)
        // The endpoint returns 'enabled' field, not 'setting'
        const isEnabled = data.enabled === true || data.enabled === "true"
        console.log("[PAYMENT-STATUS] Setting autoFulfillmentEnabled to:", isEnabled)
        setAutoFulfillmentEnabled(isEnabled)
      } else {
        console.error("[PAYMENT-STATUS] Failed to load auto-fulfillment setting:", response.status)
        const errorData = await response.json().catch(() => ({}))
        console.error("[PAYMENT-STATUS] Error response:", errorData)
      }
    } catch (error) {
      console.error("[PAYMENT-STATUS] Error loading auto-fulfillment setting:", error)
    }
  }

  const loadAllOrders = async (currentOffset: number = 0, isLoadMore: boolean = false) => {
    try {
      setLoadingAllOrders(true)
      console.log(`[PAYMENT-STATUS] Fetching orders. Offset: ${currentOffset}, LoadMore: ${isLoadMore}`)

      const params = new URLSearchParams()
      if (searchQuery) {
        params.append("search", searchQuery)
        params.append("searchType", searchType)
      }
      params.append("limit", PAGE_SIZE.toString())
      params.append("offset", currentOffset.toString())

      // Apply bulk filters to main table if active
      if (showBulkUpdate) {
        if (bulkDate) params.append("date", bulkDate)
        if (bulkNetwork && bulkNetwork !== "all") params.append("network", bulkNetwork)
        if (bulkStartTime) params.append("startTime", bulkStartTime)
        if (bulkEndTime) params.append("endTime", bulkEndTime)
        // Note: For the main table, we might NOT want to restrict status to pending/processing 
        // just yet, so the user can see everything. But if they ARE using the bulk tool,
        // it's helpful to show what they're targeting.
      }

      const response = await fetch(`/api/admin/orders/all?${params.toString()}`)

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || "Failed to load all orders")
      }

      const result = await response.json()
      console.log("[PAYMENT-STATUS] API Response Data Sample:", result.data?.[0])

      // Map data to ensure consistency with different View versions
      const mappedData = (result.data || []).map((order: any) => ({
        ...order,
        status: order.status || order.order_status || "pending",
        payment_status: order.payment_status || "completed"
      }))

      if (isLoadMore) {
        setAllOrders(prev => [...prev, ...mappedData])
      } else {
        setAllOrders(mappedData)
      }

      setTotalOrdersCount(result.count || 0)
      setHasMore(result.pagination?.hasMore || false)
    } catch (error) {
      console.error("Error loading all orders:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to load all orders"
      toast.error(errorMessage)
    } finally {
      setLoadingAllOrders(false)
    }
  }

  const handleLoadMore = () => {
    const nextOffset = offset + PAGE_SIZE
    setOffset(nextOffset)
    loadAllOrders(nextOffset, true)
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

  const handleManualFulfill = async (orderId: string, orderType: string) => {
    if (!autoFulfillmentEnabled) {
      toast.error("Auto-fulfillment is not enabled")
      return
    }

    try {
      setFulfillingOrderId(orderId)

      // Find the actual order object to inspect its data
      const orderObject = allOrders.find(o => o.id === orderId)
      console.log("[PAYMENT-STATUS] Order object to fulfill:", {
        id: orderObject?.id,
        type: orderObject?.type,
        network: orderObject?.network,
        status: orderObject?.status,
        payment_status: orderObject?.payment_status,
        fullObject: orderObject
      })
      console.log("[PAYMENT-STATUS] Triggering manual fulfillment:", { orderId, orderType })

      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Authentication required")
        return
      }

      const payload = {
        shop_order_id: orderId,
        order_type: orderType,
      }
      console.log("[PAYMENT-STATUS] Sending payload:", JSON.stringify(payload, null, 2))

      const response = await fetch("/api/admin/fulfillment/manual-fulfill", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(payload)
      })

      console.log("[PAYMENT-STATUS] Response status:", response.status)

      if (!response.ok) {
        const errorData = await response.json()
        console.error("[PAYMENT-STATUS] Error response:", errorData)
        throw new Error(errorData.error || "Failed to trigger fulfillment")
      }

      const result = await response.json()
      console.log("[PAYMENT-STATUS] Fulfillment successful:", result)
      toast.success("Fulfillment triggered successfully")

      // Update local state - change status to processing
      setAllOrders(prev => prev.map(order =>
        order.id === orderId ? { ...order, status: "processing" } : order
      ))
    } catch (error) {
      console.error("[PAYMENT-STATUS] Error triggering fulfillment:", error)
      toast.error(error instanceof Error ? error.message : "Failed to trigger fulfillment")
    } finally {
      setFulfillingOrderId(null)
    }
  }

  const handleBulkStatusUpdate = async () => {
    if (!bulkStatus) {
      toast.error("Please select a status to update to")
      return
    }

    if (!bulkDate) {
      toast.error("Please select a date")
      return
    }

    try {
      setBulkUpdating(true)

      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("You must be logged in to perform this action")
        return
      }

      console.log(`[PAYMENT-STATUS] Triggering Global Bulk Update...`)

      const payload = {
        status: bulkStatus,
        filters: {
          date: bulkDate,
          startTime: bulkStartTime,
          endTime: bulkEndTime,
          network: bulkNetwork,
          onlyPending: true // Matches the expected flow for manual fulfillment/processing
        }
      }

      const response = await fetch("/api/admin/orders/bulk-update-status", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`
        },
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || "Failed to update orders")
      }

      const result = await response.json()
      toast.success(`Successfully updated ${result.count} orders to ${bulkStatus}`)

      // Refresh data
      setOffset(0)
      loadAllOrders(0, false)
      setShowBulkUpdate(false)

      // Reset form
      setBulkStatus("")
    } catch (error) {
      console.error("[PAYMENT-STATUS] Bulk update error:", error)
      toast.error(error instanceof Error ? error.message : "Failed to update orders")
    } finally {
      setBulkUpdating(false)
    }
  }

  const handleBulkDownload = async () => {
    if (!bulkDate) {
      toast.error("Please select a date")
      return
    }

    try {
      setBulkDownloading(true)

      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("You must be logged in to perform this action")
        return
      }

      console.log(`[PAYMENT-STATUS] Triggering Global Bulk Download...`)

      const payload = {
        orderType: "all",
        isRedownload: false,
        filters: {
          date: bulkDate,
          startTime: bulkStartTime,
          endTime: bulkEndTime,
          network: bulkNetwork,
          onlyPending: true
        }
      }

      const response = await fetch("/api/admin/orders/download", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`
        },
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        if (response.status === 409) {
          toast.error("Some orders in this range were already downloaded by another admin")
        } else {
          const errorData = await response.json()
          throw new Error(errorData.error || "Failed to download orders")
        }
        return
      }

      // Download the blob
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      a.download = `orders-${bulkNetwork || 'all'}-${bulkDate}-${timestamp}.xlsx`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)

      toast.success("Download started successfully")

      // Refresh data
      setOffset(0)
      loadAllOrders(0, false)
    } catch (error) {
      console.error("[PAYMENT-STATUS] Bulk download error:", error)
      toast.error(error instanceof Error ? error.message : "Failed to download orders")
    } finally {
      setBulkDownloading(false)
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

        {/* Bulk Status Update */}
        <Card className="border-blue-200 bg-blue-50/30">
          <CardHeader className="pb-3 cursor-pointer" onClick={() => setShowBulkUpdate(!showBulkUpdate)}>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Edit className="w-5 h-5" />
                  Bulk Status Update
                </CardTitle>
                <CardDescription>Update multiple orders at once by date, time, and network</CardDescription>
              </div>
              <Button variant="ghost" size="sm">
                {showBulkUpdate ? "Hide" : "Show"}
              </Button>
            </div>
          </CardHeader>

          {showBulkUpdate && (
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* Date */}
                <div>
                  <label className="text-sm font-medium mb-1 block">Date *</label>
                  <Input
                    type="date"
                    value={bulkDate}
                    onChange={(e) => setBulkDate(e.target.value)}
                    required
                  />
                </div>

                {/* Start Time */}
                <div>
                  <label className="text-sm font-medium mb-1 block">Start Time (Optional)</label>
                  <Input
                    type="time"
                    value={bulkStartTime}
                    onChange={(e) => setBulkStartTime(e.target.value)}
                  />
                </div>

                {/* End Time */}
                <div>
                  <label className="text-sm font-medium mb-1 block">End Time (Optional)</label>
                  <Input
                    type="time"
                    value={bulkEndTime}
                    onChange={(e) => setBulkEndTime(e.target.value)}
                  />
                </div>

                {/* Network */}
                <div>
                  <label className="text-sm font-medium mb-1 block">Network (Optional)</label>
                  <select
                    value={bulkNetwork}
                    onChange={(e) => setBulkNetwork(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">All Networks</option>
                    <option value="MTN">MTN</option>
                    <option value="Telecel">Telecel</option>
                    <option value="AT - iShare">AT - iShare</option>
                    <option value="AT - BigTime">AT - BigTime</option>
                  </select>
                </div>
              </div>

              <div className="flex items-end gap-4">
                <div className="flex-1">
                  <label className="text-sm font-medium mb-1 block">New Status *</label>
                  <select
                    value={bulkStatus}
                    onChange={(e) => setBulkStatus(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  >
                    <option value="">Select status...</option>
                    <option value="pending">Pending</option>
                    <option value="processing">Processing</option>
                    <option value="completed">Completed</option>
                    <option value="failed">Failed</option>
                  </select>
                </div>

                <div className="flex gap-2">
                  <Button
                    onClick={handleBulkStatusUpdate}
                    disabled={bulkUpdating || !bulkDate || !bulkStatus}
                    className="bg-blue-600 hover:bg-blue-700 text-white min-w-[140px]"
                  >
                    {bulkUpdating ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Updating...
                      </>
                    ) : (
                      <>
                        <Zap className="w-4 h-4 mr-2" />
                        Update {globalBulkCount !== null ? `${globalBulkCount} ` : ""}Orders
                      </>
                    )}
                  </Button>

                  <Button
                    variant="outline"
                    onClick={handleBulkDownload}
                    disabled={bulkDownloading || !bulkDate}
                    className="border-green-200 hover:bg-green-50 text-green-700 font-semibold"
                  >
                    {bulkDownloading ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Preparing...
                      </>
                    ) : (
                      <>
                        <Download className="w-4 h-4 mr-2" />
                        Download {globalBulkCount !== null ? `${globalBulkCount} ` : ""}Orders
                      </>
                    )}
                  </Button>
                </div>
              </div>

              {globalBulkCount !== null && (
                <p className="text-xs text-blue-600 font-medium pt-1">
                  💡 Found {globalBulkCount} pending/processing orders matching filters in the entire database.
                </p>
              )}

              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  This will update/download ALL orders matching the criteria in the entire database. Date is required.
                </AlertDescription>
              </Alert>
            </CardContent>
          )}
        </Card>

        {/* Orders Results */}
        {
          loadingAllOrders ? (
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
                  Showing {allOrders.length} of {totalOrdersCount} order{totalOrdersCount !== 1 ? "s" : ""}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr>
                        <th className="px-4 py-2 text-left font-semibold text-gray-700">Type</th>
                        <th className="px-4 py-2 text-left font-semibold text-gray-700">Store</th>
                        <th className="px-4 py-2 text-left font-semibold text-gray-700">Shop Owner Email</th>
                        <th className="px-4 py-2 text-left font-semibold text-gray-700">Reference</th>
                        <th className="px-4 py-2 text-left font-semibold text-gray-700">Phone</th>
                        <th className="px-4 py-2 text-left font-semibold text-gray-700">Customer Email</th>
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
                          <td className="px-4 py-3 text-xs max-w-[120px] truncate" title={order.store_name || "-"}>
                            {order.type === "shop" ? (order.store_name || "-") : "-"}
                          </td>
                          <td className="px-4 py-3 text-xs max-w-[150px] truncate" title={order.shop_owner_email || "-"}>
                            {order.type === "shop" ? (order.shop_owner_email || "-") : "-"}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs max-w-xs truncate" title={order.payment_reference}>
                            {order.payment_reference}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs">{order.phone_number}</td>
                          <td className="px-4 py-3 text-xs max-w-[150px] truncate" title={order.customer_email || "-"}>
                            {order.type === "shop" ? (order.customer_email || "-") : "-"}
                          </td>
                          <td className="px-4 py-3">
                            <Badge className={`${getNetworkColor(order.network)} border`}>
                              {order.network}
                            </Badge>
                          </td>
                          <td className="px-4 py-3">{order.volume_gb}GB</td>
                          <td className="px-4 py-3 text-right font-semibold">₵ {(order.price || 0).toFixed(2)}</td>
                          <td className="px-4 py-3 text-center">
                            <Badge
                              className={`text-xs border ${order.payment_status === "completed"
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
                              className={`text-xs border ${order.status === "completed"
                                ? "bg-green-100 text-green-800 border-green-200"
                                : order.status === "pending"
                                  ? "bg-yellow-100 text-yellow-800 border-yellow-200"
                                  : order.status === "processing"
                                    ? "bg-blue-100 text-blue-800 border-blue-200"
                                    : order.status === "failed"
                                      ? "bg-red-100 text-red-800 border-red-200"
                                      : "bg-gray-100 text-gray-800 border-gray-200"
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
                            <div className="flex flex-col gap-2">
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
                              {autoFulfillmentEnabled && order.status === "pending" && order.payment_status === "completed" && (order.type === "shop" || order.type === "bulk") && order.network === "MTN" && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-xs h-7 gap-1"
                                  onClick={() => handleManualFulfill(order.id, order.type)}
                                  disabled={fulfillingOrderId === order.id}
                                  title={`Auto-fulfillment enabled: ${autoFulfillmentEnabled}, Status: ${order.status}, Payment: ${order.payment_status}, Type: ${order.type}, Network: ${order.network}`}
                                >
                                  {fulfillingOrderId === order.id ? (
                                    <>
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                      Fulfilling...
                                    </>
                                  ) : (
                                    <>
                                      <Zap className="w-3 h-3" />
                                      Fulfill
                                    </>
                                  )}
                                </Button>
                              )}
                              {autoFulfillmentEnabled && order.status === "pending" && order.payment_status === "completed" && (order.type === "shop" || order.type === "bulk") && order.network !== "MTN" && (
                                <div className="text-xs text-gray-400">{order.network} (no auto-fulfill)</div>
                              )}
                              {!autoFulfillmentEnabled && <div className="text-xs text-gray-400">Auto-fulfill disabled</div>}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Load More Button */}
                {hasMore && (
                  <div className="mt-6 flex justify-center pb-8">
                    <Button
                      variant="outline"
                      onClick={handleLoadMore}
                      disabled={loadingAllOrders}
                      className="w-full max-w-xs border-blue-200 hover:bg-blue-50 text-blue-700 font-semibold"
                    >
                      {loadingAllOrders ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Loading more...
                        </>
                      ) : (
                        <>
                          <Zap className="w-4 h-4 mr-2" />
                          Load More Orders
                        </>
                      )}
                    </Button>
                  </div>
                )}

                {!hasMore && allOrders.length > 0 && (
                  <p className="text-center text-gray-400 text-xs mt-6 pb-8">
                    No more orders to display
                  </p>
                )}
              </CardContent>
            </Card>
          )
        }
      </div >
    </DashboardLayout >
  )
}
