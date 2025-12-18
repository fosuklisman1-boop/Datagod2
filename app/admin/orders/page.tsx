"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Download, CheckCircle, Clock, AlertCircle, Check, Loader2 } from "lucide-react"
import { useAdminProtected } from "@/hooks/use-admin"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"

interface ShopOrder {
  id: string
  phone_number: string
  network: string
  size: number
  price: number
  status: string
  order_status?: string
  created_at: string
}

interface DownloadBatch {
  network: string
  downloadedAt: string
  orders: ShopOrder[]
}

interface DownloadedOrders {
  [key: string]: DownloadBatch
}

export default function AdminOrdersPage() {
  const router = useRouter()
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [activeTab, setActiveTab] = useState<"pending" | "downloaded">("pending")
  
  const [pendingOrders, setPendingOrders] = useState<ShopOrder[]>([])
  const [downloadedOrders, setDownloadedOrders] = useState<DownloadedOrders>({})
  
  const [loadingPending, setLoadingPending] = useState(true)
  const [loadingDownloaded, setLoadingDownloaded] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [updatingBatch, setUpdatingBatch] = useState<string | null>(null)
  
  const [showNetworkSelection, setShowNetworkSelection] = useState(false)
  const [selectedNetworks, setSelectedNetworks] = useState<string[]>([])
  const [downloadedBatchFilter, setDownloadedBatchFilter] = useState("all")
  const [downloadedBatchStatusFilter, setDownloadedBatchStatusFilter] = useState("all")
  const allNetworks = ["MTN", "Telecel", "AT - iShare", "AT - BigTime"]

  useEffect(() => {
    if (isAdmin && !adminLoading) {
      loadPendingOrders()
      loadDownloadedOrders()
    }
  }, [isAdmin, adminLoading])

  const loadPendingOrders = async () => {
    try {
      setLoadingPending(true)
      console.log("Fetching pending orders from API...")
      const response = await fetch("/api/admin/orders/pending")
      
      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || "Failed to load pending orders")
      }

      const result = await response.json()
      console.log("Fetched pending orders:", result.count)
      const ordersData = result.data || []
      setPendingOrders(ordersData)
      // Sync pending count to localStorage for sidebar badge
      localStorage.setItem('adminPendingOrdersCount', ordersData.length.toString())
      console.log('[ADMIN-ORDERS] Updated localStorage with admin pending count:', ordersData.length)
    } catch (error) {
      console.error("Error loading pending orders:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to load pending orders"
      toast.error(errorMessage)
    } finally {
      setLoadingPending(false)
    }
  }

  const loadDownloadedOrders = async () => {
    try {
      setLoadingDownloaded(true)
      console.log("Fetching downloaded batches from API...")
      const response = await fetch("/api/admin/orders/batches")
      
      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || "Failed to load downloaded orders")
      }

      const result = await response.json()
      console.log("Fetched download batches:", result.count)

      // Group by batch key (network + download time)
      const grouped: DownloadedOrders = {}
      result.data?.forEach((batch: any) => {
        const key = `${batch.network}-${batch.batch_time}`
        grouped[key] = {
          network: batch.network,
          downloadedAt: batch.batch_time,
          orders: batch.orders || []
        }
      })

      // Fetch current statuses for all orders
      const allOrderIds = result.data?.flatMap((batch: any) => batch.orders?.map((o: any) => o.id) || []) || []
      if (allOrderIds.length > 0) {
        console.log("[LOADED-ORDERS] Fetching current statuses for", allOrderIds.length, "orders")
        const statusResponse = await fetch("/api/admin/orders/batch-statuses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderIds: allOrderIds })
        })

        if (statusResponse.ok) {
          const { statusMap } = await statusResponse.json()
          console.log("[LOADED-ORDERS] Received status map for", Object.keys(statusMap).length, "orders")

          // Update orders with current statuses
          Object.keys(grouped).forEach((batchKey) => {
            grouped[batchKey].orders.forEach((order: any) => {
              if (statusMap[order.id]) {
                order.status = statusMap[order.id]
              }
            })
          })
        } else {
          console.warn("Failed to fetch order statuses, using cached data")
        }
      }

      setDownloadedOrders(grouped)
    } catch (error) {
      console.error("Error loading downloaded orders:", error)
      // Don't show error for batches table - it might not exist yet
    } finally {
      setLoadingDownloaded(false)
    }
  }

  const handleDownloadOrders = async () => {
    if (pendingOrders.length === 0) {
      toast.error("No pending orders to download")
      return
    }

    // Reload pending orders to ensure fresh data
    await loadPendingOrders()
    
    // Open network selection dialog
    setSelectedNetworks([]) // Reset selection
    setShowNetworkSelection(true)
  }

  const handleConfirmDownload = async () => {
    if (selectedNetworks.length === 0) {
      toast.error("Please select at least one network")
      return
    }

    try {
      setDownloading(true)

      // Filter orders by selected networks
      const filteredOrders = pendingOrders.filter(o => selectedNetworks.includes(o.network))
      
      if (filteredOrders.length === 0) {
        toast.error("No orders found for selected networks")
        return
      }

      // Call API endpoint to download orders
      const { data: { session }, error: sessionError } = await supabase.auth.getSession()
      
      if (!session?.access_token) {
        toast.error("Authentication required. Please log in again.")
        return
      }

      const response = await fetch("/api/admin/orders/download", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ 
          orderIds: filteredOrders.map(o => o.id)
        })
      })

      if (!response.ok) {
        let errorMessage = "Failed to download orders"
        try {
          const errorData = await response.json()
          errorMessage = errorData.error || errorMessage
        } catch (e) {
          // If response isn't JSON, use status text
          errorMessage = response.statusText || errorMessage
        }
        throw new Error(errorMessage)
      }

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const element = document.createElement("a")
      element.setAttribute("href", url)
      element.setAttribute("download", `orders-${selectedNetworks.join('-')}-${new Date().toISOString().split('T')[0]}.xlsx`)
      element.style.display = "none"
      document.body.appendChild(element)
      element.click()
      document.body.removeChild(element)
      window.URL.revokeObjectURL(url)

      toast.success(`Downloaded ${filteredOrders.length} orders from ${selectedNetworks.join(', ')}. Status updated to processing.`)
      
      // Close dialog and reload orders
      setShowNetworkSelection(false)
      await loadPendingOrders()
      await loadDownloadedOrders()
    } catch (error) {
      console.error("Error downloading orders:", error)
      toast.error(error instanceof Error ? error.message : "Failed to download orders")
    } finally {
      setDownloading(false)
    }
  }

  const handleRedownloadBatch = async (batchKey: string) => {
    const batch = downloadedOrders[batchKey]
    if (!batch) return

    try {
      setUpdatingBatch(batchKey)

      const { data: { session }, error: sessionError } = await supabase.auth.getSession()
      
      if (!session?.access_token) {
        toast.error("Authentication required. Please log in again.")
        return
      }

      const response = await fetch("/api/admin/orders/download", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ orderIds: batch.orders.map(o => o.id), isRedownload: true })
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || "Failed to redownload orders")
      }

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const element = document.createElement("a")
      element.setAttribute("href", url)
      element.setAttribute("download", `orders-${batch.network}-${new Date().toISOString().split('T')[0]}.xlsx`)
      element.style.display = "none"
      document.body.appendChild(element)
      element.click()
      document.body.removeChild(element)
      window.URL.revokeObjectURL(url)

      toast.success(`Redownloaded ${batch.orders.length} orders`)
    } catch (error) {
      console.error("Error redownloading batch:", error)
      toast.error(error instanceof Error ? error.message : "Failed to redownload batch")
    } finally {
      setUpdatingBatch(null)
    }
  }

  const handleBulkStatusUpdate = async (batchKey: string, newStatus: string) => {
    const batch = downloadedOrders[batchKey]
    if (!batch) return

    try {
      setUpdatingBatch(batchKey)

      // Detect order type from first order in batch
      const firstOrder = batch.orders[0] as any
      const orderType = firstOrder?.type || 'bulk'

      const response = await fetch("/api/admin/orders/bulk-update-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderIds: batch.orders.map(o => o.id),
          status: newStatus,
          orderType
        })
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || "Failed to update status")
      }

      toast.success(`Updated ${batch.orders.length} orders to ${newStatus}`)
      
      // Update the batch orders in state with new status immediately
      const updatedBatch = {
        ...batch,
        orders: batch.orders.map(order => ({
          ...order,
          status: newStatus
        }))
      }
      
      setDownloadedOrders(prev => ({
        ...prev,
        [batchKey]: updatedBatch
      }))
      
      // Reload pending orders to update counts
      await loadPendingOrders()
    } catch (error) {
      console.error("Error updating batch status:", error)
      toast.error(error instanceof Error ? error.message : "Failed to update status")
    } finally {
      setUpdatingBatch(null)
    }
  }

  const getNetworkColor = (network: string) => {
    const colors: { [key: string]: string } = {
      "MTN": "bg-orange-100 text-orange-800 border-orange-200",
      "Telecel": "bg-red-100 text-red-800 border-red-200",
      "AT - iShare": "bg-indigo-100 text-indigo-800 border-indigo-200",
      "AT - BigTime": "bg-purple-100 text-purple-800 border-purple-200",
    }
    return colors[network] || "bg-gray-100 text-gray-800 border-gray-200"
  }

  const getFilteredDownloadedOrders = () => {
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
    const monthAgo = new Date(today.getFullYear(), today.getMonth() - 1, today.getDate())
    const threeMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 3, today.getDate())

    return Object.entries(downloadedOrders).filter(([, batch]) => {
      const batchDate = new Date(batch.downloadedAt)
      const batchDateOnly = new Date(batchDate.getFullYear(), batchDate.getMonth(), batchDate.getDate())

      // Check date filter
      let dateMatch = true
      switch (downloadedBatchFilter) {
        case "today":
          dateMatch = batchDateOnly.getTime() === today.getTime()
          break
        case "yesterday":
          dateMatch = batchDateOnly.getTime() === yesterday.getTime()
          break
        case "this-week":
          dateMatch = batchDateOnly >= weekAgo && batchDateOnly <= today
          break
        case "this-month":
          dateMatch = batchDate >= monthAgo && batchDate <= now
          break
        case "this-quarter":
          dateMatch = batchDate >= threeMonthsAgo && batchDate <= now
          break
        case "all":
        default:
          dateMatch = true
      }

      if (!dateMatch) return false

      // Check status filter
      if (downloadedBatchStatusFilter === "all") return true
      
      // Filter by batch status
      const statuses = batch.orders.map(o => o.status || "processing")
      if (downloadedBatchStatusFilter === "completed") {
        return statuses.every(s => s === "completed")
      } else if (downloadedBatchStatusFilter === "failed") {
        return statuses.some(s => s === "failed")
      } else if (downloadedBatchStatusFilter === "processing") {
        return statuses.some(s => s === "processing" || s === "pending")
      } else if (downloadedBatchStatusFilter === "mixed") {
        // Show batches with mixed statuses
        const uniqueStatuses = new Set(statuses)
        return uniqueStatuses.size > 1
      }
      return true
    })
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
          <h1 className="text-4xl font-bold bg-gradient-to-r from-red-600 via-purple-600 to-pink-600 bg-clip-text text-transparent">
            Order Management
          </h1>
          <p className="text-gray-500 mt-1 font-medium">Download and manage pending orders</p>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "pending" | "downloaded")}>
          <TabsList className="grid w-full max-w-md grid-cols-2">
            <TabsTrigger value="pending" className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Pending ({pendingOrders.length})
            </TabsTrigger>
            <TabsTrigger value="downloaded" className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4" />
              Downloaded ({Object.keys(downloadedOrders).length} batches)
            </TabsTrigger>
          </TabsList>

          {/* Pending Orders Tab */}
          <TabsContent value="pending" className="space-y-4">
            {pendingOrders.length === 0 ? (
              <Card>
                <CardContent className="pt-6">
                  <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>No pending orders at the moment</AlertDescription>
                  </Alert>
                </CardContent>
              </Card>
            ) : (
              <>
                {/* Download Button */}
                <div className="flex justify-end gap-2">
                  <Button
                    onClick={handleDownloadOrders}
                    disabled={downloading || pendingOrders.length === 0}
                    className="bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white font-semibold"
                  >
                    <Download className="h-4 w-4 mr-2" />
                    {downloading ? "Downloading..." : `Download All (${pendingOrders.length})`}
                  </Button>
                </div>

                {/* Orders Table */}
                <Card>
                  <CardHeader>
                    <CardTitle>Pending Orders</CardTitle>
                    <CardDescription>
                      {pendingOrders.length} order{pendingOrders.length !== 1 ? "s" : ""} waiting to be downloaded
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 border-b">
                          <tr>
                            <th className="px-4 py-2 text-left font-semibold text-gray-700">Order ID</th>
                            <th className="px-4 py-2 text-left font-semibold text-gray-700">Network</th>
                            <th className="px-4 py-2 text-left font-semibold text-gray-700">Package</th>
                            <th className="px-4 py-2 text-left font-semibold text-gray-700">Phone</th>
                            <th className="px-4 py-2 text-right font-semibold text-gray-700">Price (GHS)</th>
                            <th className="px-4 py-2 text-center font-semibold text-gray-700">Date</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {pendingOrders.map((order) => (
                            <tr key={order.id} className="hover:bg-gray-50">
                              <td className="px-4 py-3 font-mono text-xs font-semibold">{order.id}</td>
                              <td className="px-4 py-3">
                                <Badge className={`${getNetworkColor(order.network)} border`}>
                                  {order.network}
                                </Badge>
                              </td>
                              <td className="px-4 py-3">{order.size}GB</td>
                              <td className="px-4 py-3 font-mono">{order.phone_number}</td>
                              <td className="px-4 py-3 text-right font-semibold">₵ {order.price.toFixed(2)}</td>
                              <td className="px-4 py-3 text-center text-xs text-gray-500">
                                <div>{new Date(order.created_at).toLocaleDateString()}</div>
                                <div className="text-xs text-gray-400">{new Date(order.created_at).toLocaleTimeString()}</div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              </>
            )}
          </TabsContent>

          {/* Downloaded Orders Tab */}
          <TabsContent value="downloaded" className="space-y-4">
            {/* Filter Section */}
            {Object.keys(downloadedOrders).length > 0 && (
              <>
                {/* Date Filter */}
                <Card>
                  <CardHeader>
                    <CardTitle>Filter Downloaded Batches by Date</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant={downloadedBatchFilter === "all" ? "default" : "outline"}
                        onClick={() => setDownloadedBatchFilter("all")}
                        size="sm"
                      >
                        All
                      </Button>
                      <Button
                        variant={downloadedBatchFilter === "today" ? "default" : "outline"}
                        onClick={() => setDownloadedBatchFilter("today")}
                        size="sm"
                      >
                        Today
                      </Button>
                      <Button
                        variant={downloadedBatchFilter === "yesterday" ? "default" : "outline"}
                        onClick={() => setDownloadedBatchFilter("yesterday")}
                        size="sm"
                      >
                        Yesterday
                      </Button>
                      <Button
                        variant={downloadedBatchFilter === "this-week" ? "default" : "outline"}
                        onClick={() => setDownloadedBatchFilter("this-week")}
                        size="sm"
                      >
                        This Week
                      </Button>
                      <Button
                        variant={downloadedBatchFilter === "this-month" ? "default" : "outline"}
                        onClick={() => setDownloadedBatchFilter("this-month")}
                        size="sm"
                      >
                        This Month
                      </Button>
                      <Button
                        variant={downloadedBatchFilter === "this-quarter" ? "default" : "outline"}
                        onClick={() => setDownloadedBatchFilter("this-quarter")}
                        size="sm"
                      >
                        This Quarter
                      </Button>
                    </div>
                  </CardContent>
                </Card>

                {/* Status Filter */}
                <Card>
                  <CardHeader>
                    <CardTitle>Filter Downloaded Batches by Status</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant={downloadedBatchStatusFilter === "all" ? "default" : "outline"}
                        onClick={() => setDownloadedBatchStatusFilter("all")}
                        size="sm"
                      >
                        All
                      </Button>
                      <Button
                        variant={downloadedBatchStatusFilter === "completed" ? "default" : "outline"}
                        onClick={() => setDownloadedBatchStatusFilter("completed")}
                        size="sm"
                      >
                        All Completed
                      </Button>
                      <Button
                        variant={downloadedBatchStatusFilter === "processing" ? "default" : "outline"}
                        onClick={() => setDownloadedBatchStatusFilter("processing")}
                        size="sm"
                      >
                        Processing
                      </Button>
                      <Button
                        variant={downloadedBatchStatusFilter === "failed" ? "default" : "outline"}
                        onClick={() => setDownloadedBatchStatusFilter("failed")}
                        size="sm"
                      >
                        Has Failures
                      </Button>
                      <Button
                        variant={downloadedBatchStatusFilter === "mixed" ? "default" : "outline"}
                        onClick={() => setDownloadedBatchStatusFilter("mixed")}
                        size="sm"
                      >
                        Mixed Status
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </>
            )}

            {Object.keys(downloadedOrders).length === 0 ? (
              <Card>
                <CardContent className="pt-6">
                  <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>No downloaded orders yet</AlertDescription>
                  </Alert>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-6">
                {getFilteredDownloadedOrders().length === 0 ? (
                  <Card>
                    <CardContent className="pt-6">
                      <Alert>
                        <AlertCircle className="h-4 w-4" />
                        <AlertDescription>No downloaded batches found for the selected date range</AlertDescription>
                      </Alert>
                    </CardContent>
                  </Card>
                ) : (
                  getFilteredDownloadedOrders().map(([batchKey, batch]) => (
                  <Card key={batchKey} className="border-l-4 border-l-emerald-500">
                    <CardHeader>
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                        <div>
                          <CardTitle className="flex items-center gap-2">
                            <Badge className="bg-emerald-100 text-emerald-800 border border-emerald-200">
                              {batch.network}
                            </Badge>
                            <span className="text-gray-600">Batch</span>
                          </CardTitle>
                          <CardDescription>
                            Downloaded: {new Date(batch.downloadedAt).toLocaleString()}
                          </CardDescription>
                        </div>
                        <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full sm:w-auto">
                          <Badge className="bg-blue-100 text-blue-800 border border-blue-200 text-lg px-3 py-1 w-full sm:w-auto text-center">
                            {batch.orders.length} orders
                          </Badge>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleRedownloadBatch(batchKey)}
                            disabled={updatingBatch === batchKey}
                            className="w-full sm:w-auto"
                          >
                            <Download className="h-4 w-4 mr-2" />
                            Redownload
                          </Button>
                          <select
                            className="px-3 py-2 border rounded-md text-sm w-full sm:w-auto"
                            onChange={(e) => handleBulkStatusUpdate(batchKey, e.target.value)}
                            disabled={updatingBatch === batchKey}
                            defaultValue=""
                            aria-label="Update batch status"
                          >
                            <option value="">Update Status</option>
                            <option value="completed">Completed</option>
                            <option value="failed">Failed</option>
                          </select>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-gray-50 border-b">
                            <tr>
                              <th className="px-2 sm:px-4 py-2 text-left font-semibold text-gray-700 text-xs sm:text-sm">Order ID</th>
                              <th className="px-2 sm:px-4 py-2 text-left font-semibold text-gray-700 text-xs sm:text-sm">Network</th>
                              <th className="px-2 sm:px-4 py-2 text-left font-semibold text-gray-700 text-xs sm:text-sm">Package</th>
                              <th className="px-2 sm:px-4 py-2 text-left font-semibold text-gray-700 text-xs sm:text-sm">Phone</th>
                              <th className="px-2 sm:px-4 py-2 text-right font-semibold text-gray-700 text-xs sm:text-sm">Price (GHS)</th>
                              <th className="px-2 sm:px-4 py-2 text-center font-semibold text-gray-700 text-xs sm:text-sm">Status</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y">
                            {batch.orders.map((order: any) => (
                              <tr key={order.id} className="hover:bg-gray-50">
                                <td className="px-2 sm:px-4 py-3 font-mono text-xs font-semibold">{order.id}</td>
                                <td className="px-2 sm:px-4 py-3">
                                  <Badge className={`${getNetworkColor(order.network)} border text-xs`}>
                                    {order.network}
                                  </Badge>
                                </td>
                                <td className="px-2 sm:px-4 py-3 text-xs sm:text-sm">{order.size}GB</td>
                                <td className="px-2 sm:px-4 py-3 font-mono text-xs">{order.phone_number}</td>
                                <td className="px-2 sm:px-4 py-3 text-right font-semibold text-xs sm:text-sm">₵ {order.price.toFixed(2)}</td>
                                <td className="px-2 sm:px-4 py-3 text-center">
                                  <Badge className={`border text-xs ${
                                    order.status === "completed" ? "bg-green-100 text-green-800 border-green-200" :
                                    order.status === "failed" ? "bg-red-100 text-red-800 border-red-200" :
                                    order.status === "processing" ? "bg-blue-100 text-blue-800 border-blue-200" :
                                    "bg-gray-100 text-gray-800 border-gray-200"
                                  }`}>
                                    {order.status?.charAt(0).toUpperCase() + order.status?.slice(1) || "Processing"}
                                  </Badge>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </Card>
                  ))
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>

        {/* Network Selection Dialog */}
        <Dialog open={showNetworkSelection} onOpenChange={setShowNetworkSelection}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Select Networks to Download</DialogTitle>
              <DialogDescription>
                Choose which networks you want to download orders for. 
                {pendingOrders.length > 0 && (
                  <span className="block mt-2 text-sm">
                    Available orders: {pendingOrders.length}
                  </span>
                )}
              </DialogDescription>
            </DialogHeader>
            
            <div className="space-y-2">
              {allNetworks.map((network) => {
                const networkOrders = pendingOrders.filter(o => o.network === network)
                const networkOrderCount = networkOrders.length
                const isSelected = selectedNetworks.includes(network)
                const isDisabled = networkOrderCount === 0
                
                return (
                  <button
                    key={network}
                    type="button"
                    onClick={() => {
                      if (!isDisabled) {
                        if (isSelected) {
                          setSelectedNetworks(selectedNetworks.filter(n => n !== network))
                        } else {
                          setSelectedNetworks([...selectedNetworks, network])
                        }
                      }
                    }}
                    disabled={isDisabled}
                    className={`w-full flex items-center gap-3 p-3 rounded border-2 transition-all ${
                      isSelected 
                        ? 'bg-blue-50 border-blue-500' 
                        : 'bg-white border-gray-200 hover:border-gray-300'
                    } ${isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    <div className={`flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center ${
                      isSelected 
                        ? 'bg-blue-500 border-blue-500' 
                        : 'border-gray-300 bg-white'
                    }`}>
                      {isSelected && <Check className="w-4 h-4 text-white" />}
                    </div>
                    <div className="flex-1 text-left">
                      <span className="font-medium text-gray-900">{network}</span>
                      <span className="text-sm text-gray-500 ml-2">
                        ({networkOrderCount} order{networkOrderCount !== 1 ? 's' : ''})
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>

            <DialogFooter className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setShowNetworkSelection(false)}
                disabled={downloading}
              >
                Cancel
              </Button>
              <Button
                onClick={handleConfirmDownload}
                disabled={downloading || selectedNetworks.length === 0}
                className="bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white"
              >
                {downloading ? "Downloading..." : "Download Selected"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  )
}
