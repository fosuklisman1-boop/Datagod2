"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Download, CheckCircle, Clock, AlertCircle } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

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
  const [isAdmin, setIsAdmin] = useState(false)
  const [activeTab, setActiveTab] = useState<"pending" | "downloaded">("pending")
  
  const [pendingOrders, setPendingOrders] = useState<ShopOrder[]>([])
  const [downloadedOrders, setDownloadedOrders] = useState<DownloadedOrders>({})
  
  const [loadingPending, setLoadingPending] = useState(true)
  const [loadingDownloaded, setLoadingDownloaded] = useState(false)
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    checkAdminAccess()
  }, [])

  const checkAdminAccess = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const role = user?.user_metadata?.role

      if (role !== "admin") {
        toast.error("Unauthorized access")
        router.push("/dashboard")
        return
      }

      setIsAdmin(true)
      await loadPendingOrders()
      await loadDownloadedOrders()
    } catch (error) {
      console.error("Error checking admin access:", error)
      router.push("/dashboard")
    }
  }

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
      setPendingOrders(result.data || [])
    } catch (error) {
      console.error("Error loading pending orders:", error)
      toast.error("Failed to load pending orders")
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

    try {
      setDownloading(true)

      // Call API endpoint to download orders
      const response = await fetch("/api/admin/orders/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds: pendingOrders.map(o => o.id) })
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || "Failed to download orders")
      }

      const result = await response.json()

      // Download CSV file
      const csv = result.csv
      const element = document.createElement("a")
      element.setAttribute("href", "data:text/csv;charset=utf-8," + encodeURIComponent(csv))
      element.setAttribute("download", `orders-${new Date().toISOString().split('T')[0]}.csv`)
      element.style.display = "none"
      document.body.appendChild(element)
      element.click()
      document.body.removeChild(element)

      toast.success(`Downloaded ${pendingOrders.length} orders. Status updated to processing.`)
      
      // Reload orders
      await loadPendingOrders()
      await loadDownloadedOrders()
    } catch (error) {
      console.error("Error downloading orders:", error)
      toast.error(error instanceof Error ? error.message : "Failed to download orders")
    } finally {
      setDownloading(false)
    }
  }

  const getNetworkColor = (network: string) => {
    const colors: { [key: string]: string } = {
      "MTN": "bg-orange-100 text-orange-800 border-orange-200",
      "Telecel": "bg-red-100 text-red-800 border-red-200",
      "AT": "bg-blue-100 text-blue-800 border-blue-200",
      "AT - iShare": "bg-indigo-100 text-indigo-800 border-indigo-200",
      "AT - BigTime": "bg-purple-100 text-purple-800 border-purple-200",
      "iShare": "bg-green-100 text-green-800 border-green-200",
    }
    return colors[network] || "bg-gray-100 text-gray-800 border-gray-200"
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
                              <td className="px-4 py-3 text-right font-semibold">₦ {order.price.toFixed(2)}</td>
                              <td className="px-4 py-3 text-center text-xs text-gray-500">
                                {new Date(order.created_at).toLocaleDateString()}
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
                {Object.entries(downloadedOrders).map(([batchKey, batch]) => (
                  <Card key={batchKey} className="border-l-4 border-l-emerald-500">
                    <CardHeader>
                      <div className="flex items-center justify-between">
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
                        <Badge className="bg-blue-100 text-blue-800 border border-blue-200 text-lg px-3 py-1">
                          {batch.orders.length} orders
                        </Badge>
                      </div>
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
                              <th className="px-4 py-2 text-center font-semibold text-gray-700">Status</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y">
                            {batch.orders.map((order: any) => (
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
                                <td className="px-4 py-3 text-center">
                                  <Badge className="bg-blue-100 text-blue-800 border border-blue-200">
                                    Processing
                                  </Badge>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  )
}
