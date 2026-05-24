"use client"

import { useState, useEffect } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { RefreshCw, Download, AlertCircle, CheckCircle, Clock, XCircle, Trash2, Zap } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

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

interface StatusCounts {
  total: number
  success: number
  failed: number
  processing: number
  pending: number
}

interface Pagination {
  page: number
  limit: number
  total: number
  totalPages: number
}

export default function AdminFulfillmentPage() {
  const [fulfillments, setFulfillments] = useState<FulfillmentOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<"all" | "success" | "failed" | "pending" | "processing">("all")
  const [searchPhone, setSearchPhone] = useState("")
  const [committedPhone, setCommittedPhone] = useState("")
  const [page, setPage] = useState(1)
  const [pagination, setPagination] = useState<Pagination | null>(null)
  const [statusCounts, setStatusCounts] = useState<StatusCounts | null>(null)
  const [retrying, setRetrying] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [syncingCodecraft, setSyncingCodecraft] = useState(false)

  useEffect(() => {
    loadFulfillments(1)
    const interval = setInterval(() => loadFulfillments(page), 30000)
    return () => clearInterval(interval)
  }, [filter, committedPhone])

  const loadFulfillments = async (targetPage: number) => {
    try {
      setLoading(true)

      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Authentication required")
        return
      }

      const params = new URLSearchParams({ page: String(targetPage), limit: "50" })
      if (filter !== "all") params.set("status", filter)
      if (committedPhone) params.set("phone", committedPhone)

      const response = await fetch(`/api/admin/fulfillment/logs?${params}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })

      if (!response.ok) {
        const error = await response.json()
        toast.error(error.error || "Failed to load fulfillments")
        return
      }

      const data = await response.json()
      setFulfillments(data.logs || [])
      setPagination(data.pagination ?? null)
      setStatusCounts(data.statusCounts ?? null)
      setPage(targetPage)
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
      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch("/api/orders/fulfillment", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          action: "retry",
          orderId,
        }),
      })

      const data = await response.json()

      if (data.success) {
        toast.success("Retry triggered successfully")
        loadFulfillments(page)
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

  const handleBulkDeleteFailed = async () => {
    if (!confirm("Are you sure you want to permanently delete ALL failed fulfillment logs? This action cannot be undone.")) return;

    try {
      setDeleting("bulk")
      const { data: { session } } = await supabase.auth.getSession()
      
      const response = await fetch(`/api/admin/fulfillment/logs?bulk=failed`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
        },
      })

      const data = await response.json()

      if (data.success) {
        toast.success("Failed logs cleared successfully")
        loadFulfillments(1)
      } else {
        toast.error(data.error || "Failed to clear logs")
      }
    } catch (error) {
      console.error("Error:", error)
      toast.error("An error occurred")
    } finally {
      setDeleting(null)
    }
  }

  const handleSyncCodecraft = async () => {
    try {
      setSyncingCodecraft(true)
      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch("/api/admin/fulfillment/sync-codecraft", {
        method: "POST",
        headers: { Authorization: `Bearer ${session?.access_token}` },
      })
      const data = await response.json()
      if (data.success) {
        toast.success(data.message)
        loadFulfillments(page)
      } else {
        toast.error(data.error || "Sync failed")
      }
    } catch (error) {
      toast.error("An error occurred during sync")
    } finally {
      setSyncingCodecraft(false)
    }
  }

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
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); return }

      // Fetch all records for the current filter (max 500 per API limit)
      const params = new URLSearchParams({ page: "1", limit: "500" })
      if (filter !== "all") params.set("status", filter)
      if (committedPhone) params.set("phone", committedPhone)

      const response = await fetch(`/api/admin/fulfillment/logs?${params}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const data = await response.json()
      const csv = generateCSV(data.logs || [])
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

  const stats = statusCounts ?? {
    total: 0, success: 0, failed: 0, processing: 0, pending: 0,
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
                <p className="text-3xl font-bold">{formatCount(stats.total)}</p>
                <p className="text-sm text-gray-600">Total Orders</p>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-green-50">
            <CardContent className="pt-6">
              <div className="text-center">
                <p className="text-3xl font-bold text-green-600">{formatCount(stats.success)}</p>
                <p className="text-sm text-gray-600">Success</p>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-red-50">
            <CardContent className="pt-6">
              <div className="text-center">
                <p className="text-3xl font-bold text-red-600">{formatCount(stats.failed)}</p>
                <p className="text-sm text-gray-600">Failed</p>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-blue-50">
            <CardContent className="pt-6">
              <div className="text-center">
                <p className="text-3xl font-bold text-blue-600">{formatCount(stats.processing)}</p>
                <p className="text-sm text-gray-600">Processing</p>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-gray-50">
            <CardContent className="pt-6">
              <div className="text-center">
                <p className="text-3xl font-bold text-gray-600">{formatCount(stats.pending)}</p>
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
                  onClick={() => { setFilter(status); setPage(1) }}
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
                onKeyDown={(e) => { if (e.key === "Enter") { setCommittedPhone(searchPhone); setPage(1) } }}
                className="flex-1"
              />
              <Button size="sm" onClick={() => { setCommittedPhone(searchPhone); setPage(1) }}>
                Search
              </Button>
              <Button onClick={() => loadFulfillments(page)} size="sm" variant="outline">
                <RefreshCw className="w-4 h-4 mr-2" />
                Refresh
              </Button>
              <Button
                onClick={handleSyncCodecraft}
                size="sm"
                variant="outline"
                disabled={syncingCodecraft}
                className="border-purple-200 text-purple-700 hover:bg-purple-50"
              >
                {syncingCodecraft
                  ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  : <Zap className="w-4 h-4 mr-2" />
                }
                {syncingCodecraft ? "Syncing..." : "Sync Codecraft"}
              </Button>
              <Button onClick={downloadReport} size="sm" variant="outline">
                <Download className="w-4 h-4 mr-2" />
                Export
              </Button>
              <Button 
                onClick={handleBulkDeleteFailed} 
                size="sm" 
                variant="destructive"
                disabled={deleting === "bulk"}
              >
                {deleting === "bulk" ? <Clock className="w-4 h-4 mr-2 animate-spin" /> : <Trash2 className="w-4 h-4 mr-2" />}
                Clear Failed Logs
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Fulfillment List */}
        <Card>
          <CardHeader>
            <CardTitle>Fulfillment Orders</CardTitle>
            <CardDescription>
              {pagination
                ? `Showing ${(page - 1) * pagination.limit + 1}–${Math.min(page * pagination.limit, pagination.total)} of ${formatCount(pagination.total)} orders`
                : "Loading..."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="text-center py-8">
                <p className="text-gray-600">Loading...</p>
              </div>
            ) : fulfillments.length === 0 ? (
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
                    {fulfillments.map((fulfillment) => (
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
                          <div className="flex gap-2 items-center">
                            {fulfillment.status === "failed" &&
                              fulfillment.attempt_number < fulfillment.max_attempts && (
                                <Button
                                  size="sm"
                                  onClick={() => handleRetry(fulfillment.order_id)}
                                  disabled={retrying === fulfillment.order_id || deleting === "bulk"}
                                >
                                  {retrying === fulfillment.order_id ? "Retrying..." : "Retry"}
                                </Button>
                              )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {pagination && pagination.totalPages > 1 && (
                  <div className="flex items-center justify-between pt-4 border-t mt-2">
                    <span className="text-xs text-gray-500">
                      Page {page} of {pagination.totalPages} &mdash; {formatCount(pagination.total)} total
                    </span>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={page <= 1 || loading}
                        onClick={() => loadFulfillments(page - 1)}
                      >
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={page >= pagination.totalPages || loading}
                        onClick={() => loadFulfillments(page + 1)}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
