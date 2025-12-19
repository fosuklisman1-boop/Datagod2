"use client"

import { useState, useEffect } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { RefreshCw, Download, AlertCircle, CheckCircle, Clock, XCircle } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

interface FulfillmentOrder {
  id: string
  order_id: string
  network: string
  phone_number: string
  status: string
  attempt_number: number
  max_attempts: number
  error_message?: string
  created_at: string
  updated_at: string
  fulfilled_at?: string
  retry_after?: string
}

export default function AdminFulfillmentPage() {
  const [fulfillments, setFulfillments] = useState<FulfillmentOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<"all" | "success" | "failed" | "pending" | "processing">("all")
  const [searchPhone, setSearchPhone] = useState("")
  const [retrying, setRetrying] = useState<string | null>(null)

  useEffect(() => {
    loadFulfillments()
    // Refresh every 30 seconds
    const interval = setInterval(loadFulfillments, 30000)
    return () => clearInterval(interval)
  }, [filter])

  const loadFulfillments = async () => {
    try {
      setLoading(true)
      let query = supabase
        .from("fulfillment_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100)

      if (filter !== "all") {
        query = query.eq("status", filter)
      }

      const { data, error } = await query

      if (error) {
        console.error("Error loading fulfillments:", error)
        toast.error("Failed to load fulfillments")
        return
      }

      setFulfillments(data || [])
    } catch (error) {
      console.error("Error:", error)
      toast.error("An error occurred")
    } finally {
      setLoading(false)
    }
  }

  const handleRetry = async (orderId: string) => {
    try {
      setRetrying(orderId)
      const response = await fetch("/api/orders/fulfillment", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "retry",
          orderId,
        }),
      })

      const data = await response.json()

      if (data.success) {
        toast.success("Retry triggered successfully")
        loadFulfillments()
      } else {
        toast.error(data.message || "Failed to retry fulfillment")
      }
    } catch (error) {
      console.error("Error:", error)
      toast.error("An error occurred")
    } finally {
      setRetrying(null)
    }
  }

  const filteredFulfillments = fulfillments.filter((f) =>
    searchPhone ? f.phone_number.includes(searchPhone) : true
  )

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "success":
        return <CheckCircle className="w-4 h-4 text-green-600" />
      case "failed":
        return <XCircle className="w-4 h-4 text-red-600" />
      case "processing":
        return <Clock className="w-4 h-4 text-blue-600" />
      default:
        return <Clock className="w-4 h-4 text-gray-400" />
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "success":
        return "bg-green-100 text-green-800"
      case "failed":
        return "bg-red-100 text-red-800"
      case "processing":
        return "bg-blue-100 text-blue-800"
      default:
        return "bg-gray-100 text-gray-800"
    }
  }

  const downloadReport = async () => {
    try {
      const csv = generateCSV(filteredFulfillments)
      const blob = new Blob([csv], { type: "text/csv" })
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `fulfillment-report-${new Date().toISOString().split("T")[0]}.csv`
      a.click()
      window.URL.revokeObjectURL(url)
      toast.success("Report downloaded successfully")
    } catch (error) {
      console.error("Error:", error)
      toast.error("Failed to download report")
    }
  }

  const generateCSV = (data: FulfillmentOrder[]) => {
    const headers = [
      "Order ID",
      "Network",
      "Phone Number",
      "Status",
      "Attempts",
      "Error",
      "Created At",
      "Fulfilled At",
    ]
    const rows = data.map((f) => [
      f.order_id,
      f.network,
      f.phone_number,
      f.status,
      `${f.attempt_number}/${f.max_attempts}`,
      f.error_message || "-",
      new Date(f.created_at).toLocaleString(),
      f.fulfilled_at ? new Date(f.fulfilled_at).toLocaleString() : "-",
    ])

    return [
      headers.join(","),
      ...rows.map((r) => r.map((cell) => `"${cell}"`).join(",")),
    ].join("\n")
  }

  const stats = {
    total: fulfillments.length,
    success: fulfillments.filter((f) => f.status === "success").length,
    failed: fulfillments.filter((f) => f.status === "failed").length,
    processing: fulfillments.filter((f) => f.status === "processing").length,
    pending: fulfillments.filter((f) => f.status === "pending").length,
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold">Data Bundle Fulfillment Manager</h1>
          <p className="text-gray-600 mt-1">Monitor and manage data bundle order fulfillments (MTN, TELECEL, AT)</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="text-center">
                <p className="text-3xl font-bold">{stats.total}</p>
                <p className="text-sm text-gray-600">Total Orders</p>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-green-50">
            <CardContent className="pt-6">
              <div className="text-center">
                <p className="text-3xl font-bold text-green-600">{stats.success}</p>
                <p className="text-sm text-gray-600">Success</p>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-red-50">
            <CardContent className="pt-6">
              <div className="text-center">
                <p className="text-3xl font-bold text-red-600">{stats.failed}</p>
                <p className="text-sm text-gray-600">Failed</p>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-blue-50">
            <CardContent className="pt-6">
              <div className="text-center">
                <p className="text-3xl font-bold text-blue-600">{stats.processing}</p>
                <p className="text-sm text-gray-600">Processing</p>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-gray-50">
            <CardContent className="pt-6">
              <div className="text-center">
                <p className="text-3xl font-bold text-gray-600">{stats.pending}</p>
                <p className="text-sm text-gray-600">Pending</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <Card>
          <CardHeader>
            <CardTitle>Filters</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {(["all", "success", "failed", "processing", "pending"] as const).map((status) => (
                <Button
                  key={status}
                  variant={filter === status ? "default" : "outline"}
                  size="sm"
                  onClick={() => setFilter(status)}
                  className="capitalize"
                >
                  {status}
                </Button>
              ))}
            </div>

            <div className="flex gap-2">
              <Input
                placeholder="Search by phone number..."
                value={searchPhone}
                onChange={(e) => setSearchPhone(e.target.value)}
                className="flex-1"
              />
              <Button onClick={loadFulfillments} size="sm">
                <RefreshCw className="w-4 h-4 mr-2" />
                Refresh
              </Button>
              <Button onClick={downloadReport} size="sm" variant="outline">
                <Download className="w-4 h-4 mr-2" />
                Export
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Fulfillment List */}
        <Card>
          <CardHeader>
            <CardTitle>Fulfillment Orders</CardTitle>
            <CardDescription>Showing {filteredFulfillments.length} orders</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="text-center py-8">
                <p className="text-gray-600">Loading...</p>
              </div>
            ) : filteredFulfillments.length === 0 ? (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>No fulfillments found</AlertDescription>
              </Alert>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-3 px-4 font-semibold">Status</th>
                      <th className="text-left py-3 px-4 font-semibold">Order ID</th>
                      <th className="text-left py-3 px-4 font-semibold">Phone</th>
                      <th className="text-left py-3 px-4 font-semibold">Attempts</th>
                      <th className="text-left py-3 px-4 font-semibold">Created</th>
                      <th className="text-left py-3 px-4 font-semibold">Error</th>
                      <th className="text-left py-3 px-4 font-semibold">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredFulfillments.map((fulfillment) => (
                      <tr key={fulfillment.id} className="border-b hover:bg-gray-50">
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2">
                            {getStatusIcon(fulfillment.status)}
                            <Badge className={getStatusColor(fulfillment.status)}>
                              {fulfillment.status}
                            </Badge>
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <code className="text-xs bg-gray-100 px-2 py-1 rounded">
                            {fulfillment.order_id.substring(0, 8)}...
                          </code>
                        </td>
                        <td className="py-3 px-4">{fulfillment.phone_number}</td>
                        <td className="py-3 px-4">
                          {fulfillment.attempt_number}/{fulfillment.max_attempts}
                        </td>
                        <td className="py-3 px-4 text-xs">
                          {new Date(fulfillment.created_at).toLocaleString()}
                        </td>
                        <td className="py-3 px-4 text-xs">
                          {fulfillment.error_message ? (
                            <div className="max-w-xs text-red-600 truncate">
                              {fulfillment.error_message}
                            </div>
                          ) : (
                            "-"
                          )}
                        </td>
                        <td className="py-3 px-4">
                          {fulfillment.status === "failed" &&
                            fulfillment.attempt_number < fulfillment.max_attempts && (
                              <Button
                                size="sm"
                                onClick={() => handleRetry(fulfillment.order_id)}
                                disabled={retrying === fulfillment.order_id}
                              >
                                {retrying === fulfillment.order_id ? "Retrying..." : "Retry"}
                              </Button>
                            )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
