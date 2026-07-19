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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Download, CheckCircle, Clock, AlertCircle, Check, Loader2, Zap, ToggleLeft, ToggleRight, RefreshCw, Search, Send, ChevronDown, ShieldCheck, XCircle, Trash2 } from "lucide-react"
import { useAdminProtected } from "@/hooks/use-admin"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"

// Format large numbers with commas or K/M suffix
const formatCount = (num: number): string => {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
  }
  if (num >= 10000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  }
  return num.toLocaleString()
}

interface ShopOrder {
  id: string
  phone_number: string
  network: string
  size: number
  price: number
  status: string
  order_status?: string
  created_at: string
  type?: string
}

interface DownloadBatch {
  network: string
  downloadedAt: string
  orders: ShopOrder[]
  downloadedByEmail?: string
}

interface DownloadedOrders {
  [key: string]: DownloadBatch
}

interface FulfillmentLog {
  id: string
  order_id: string
  network: string
  phone_number: string
  status: string
  attempt_number: number
  max_attempts: number
  error_message?: string
  created_at: string
  fulfilled_at?: string
}
interface LogStatusCounts { total: number; success: number; failed: number; processing: number; pending: number }
interface LogPagination { page: number; limit: number; total: number; totalPages: number }

export default function AdminOrdersPage() {
  const router = useRouter()
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [activeTab, setActiveTab] = useState<"pending" | "downloaded" | "fulfillment">("pending")

  const [pendingOrders, setPendingOrders] = useState<ShopOrder[]>([])
  const [pendingTrueCount, setPendingTrueCount] = useState(0)
  const [downloadedOrders, setDownloadedOrders] = useState<DownloadedOrders>({})

  const [loadingPending, setLoadingPending] = useState(true)
  const [loadingDownloaded, setLoadingDownloaded] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [updatingBatch, setUpdatingBatch] = useState<string | null>(null)

  const [showNetworkSelection, setShowNetworkSelection] = useState(false)
  const [selectedNetworks, setSelectedNetworks] = useState<string[]>([])
  // When ON, a number with several pending orders is exported as ONE row with the
  // gigs summed. Turn OFF for suppliers that only accept fixed pack sizes.
  const [combineDuplicates, setCombineDuplicates] = useState(true)
  const [downloadedBatchFilter, setDownloadedBatchFilter] = useState("all")
  const [downloadedBatchStatusFilter, setDownloadedBatchStatusFilter] = useState("all")
  const [downloadedBatchSearch, setDownloadedBatchSearch] = useState("")
  const [downloadedNetworkFilter, setDownloadedNetworkFilter] = useState("all")
  const allNetworks = ["MTN", "Telecel", "AT - iShare", "AT - BigTime"]

  // Fulfillment log state (for the Fulfillment tab)
  const [logFulfillments, setLogFulfillments] = useState<FulfillmentLog[]>([])
  const [logLoading, setLogLoading] = useState(false)
  const [logFilter, setLogFilter] = useState<"all" | "success" | "failed" | "pending" | "processing">("all")
  const [logSearchPhone, setLogSearchPhone] = useState("")
  const [logCommittedPhone, setLogCommittedPhone] = useState("")
  const [logPage, setLogPage] = useState(1)
  const [logPagination, setLogPagination] = useState<LogPagination | null>(null)
  const [logStatusCounts, setLogStatusCounts] = useState<LogStatusCounts | null>(null)
  const [logRetrying, setLogRetrying] = useState<string | null>(null)
  const [logDeleting, setLogDeleting] = useState<string | null>(null)
  const [logSyncingCodecraft, setLogSyncingCodecraft] = useState(false)

  // Fulfill progress dialog
  type ProgressStep = { label: string; status: "idle" | "running" | "done" | "error"; detail?: string }
  const [fulfillProgress, setFulfillProgress] = useState<{
    open: boolean
    orderId: string
    orderType: string
    phone: string
    provider: string
    steps: ProgressStep[]
    done: boolean
  }>({ open: false, orderId: "", orderType: "", phone: "", provider: "", steps: [], done: false })

  // Bulk delete state
  const [deleteBatchesEndDate, setDeleteBatchesEndDate] = useState("")
  const [deletingBatches, setDeletingBatches] = useState(false)

  // MTN Fulfillment state
  const [pendingMTNOrders, setPendingMTNOrders] = useState<ShopOrder[]>([])
  const [loadingMTNOrders, setLoadingMTNOrders] = useState(false)
  const [fulfillingMTNOrder, setFulfillingMTNOrder] = useState<string | null>(null)
  const [mtnFulfillmentStatus, setMTNFulfillmentStatus] = useState<{ [key: string]: string }>({})

  useEffect(() => {
    if (isAdmin && !adminLoading) {
      loadPendingOrders()
      loadDownloadedOrders()
      if (activeTab === "fulfillment") {
        loadFulfillmentLogs(1)
      }
    }
  }, [isAdmin, adminLoading, activeTab])

  const loadFulfillmentLogs = async (targetPage: number) => {
    try {
      setLogLoading(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const params = new URLSearchParams({ page: String(targetPage), limit: "50" })
      if (logFilter !== "all") params.set("status", logFilter)
      if (logCommittedPhone) params.set("phone", logCommittedPhone)
      const response = await fetch(`/api/admin/fulfillment/logs?${params}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (!response.ok) { toast.error("Failed to load fulfillment logs"); return }
      const data = await response.json()
      setLogFulfillments(data.logs || [])
      setLogPagination(data.pagination ?? null)
      setLogStatusCounts(data.statusCounts ?? null)
      setLogPage(targetPage)
    } catch (error) {
      console.error("Error loading fulfillment logs:", error)
    } finally {
      setLogLoading(false)
    }
  }

  const handleLogRetry = async (orderId: string) => {
    try {
      setLogRetrying(orderId)
      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch("/api/orders/fulfillment", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({ action: "retry", orderId }),
      })
      const data = await response.json()
      if (data.success) { toast.success("Retry triggered"); loadFulfillmentLogs(logPage) }
      else toast.error(data.message || "Failed to retry")
    } catch { toast.error("An error occurred") }
    finally { setLogRetrying(null) }
  }

  const handleLogBulkDeleteFailed = async () => {
    if (!confirm("Delete ALL failed fulfillment logs? This cannot be undone.")) return
    try {
      setLogDeleting("bulk")
      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch(`/api/admin/fulfillment/logs?bulk=failed`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session?.access_token}` },
      })
      const data = await response.json()
      if (data.success) { toast.success("Failed logs cleared"); loadFulfillmentLogs(1) }
      else toast.error(data.error || "Failed to clear logs")
    } catch { toast.error("An error occurred") }
    finally { setLogDeleting(null) }
  }

  const handleLogSyncCodecraft = async () => {
    try {
      setLogSyncingCodecraft(true)
      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch("/api/admin/fulfillment/sync-codecraft", {
        method: "POST",
        headers: { Authorization: `Bearer ${session?.access_token}` },
      })
      const data = await response.json()
      if (data.success) { toast.success(data.message); loadFulfillmentLogs(logPage) }
      else toast.error(data.error || "Sync failed")
    } catch { toast.error("Sync error") }
    finally { setLogSyncingCodecraft(false) }
  }

  const handleLogDownloadReport = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); return }
      const params = new URLSearchParams({ page: "1", limit: "500" })
      if (logFilter !== "all") params.set("status", logFilter)
      if (logCommittedPhone) params.set("phone", logCommittedPhone)
      const response = await fetch(`/api/admin/fulfillment/logs?${params}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const data = await response.json()
      const headers = ["Order ID","Network","Phone","Status","Attempts","Error","Created At","Fulfilled At"]
      const rows = (data.logs || []).map((f: FulfillmentLog) => [
        f.order_id, f.network, f.phone_number, f.status,
        `${f.attempt_number}/${f.max_attempts}`, f.error_message || "-",
        new Date(f.created_at).toLocaleString(),
        f.fulfilled_at ? new Date(f.fulfilled_at).toLocaleString() : "-",
      ])
      const csv = [headers.join(","), ...rows.map((r: string[]) => r.map(c => `"${c}"`).join(","))].join("\n")
      const blob = new Blob([csv], { type: "text/csv" })
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement("a"); a.href = url
      a.download = `fulfillment-${new Date().toISOString().split("T")[0]}.csv`; a.click()
      window.URL.revokeObjectURL(url)
      toast.success("Report downloaded")
    } catch { toast.error("Failed to download report") }
  }

  const getLogStatusIcon = (status: string) => {
    if (status === "success") return <CheckCircle className="w-4 h-4 text-success" />
    if (status === "failed") return <XCircle className="w-4 h-4 text-destructive" />
    return <Clock className="w-4 h-4 text-muted-foreground" />
  }

  const getLogStatusColor = (status: string) => {
    if (status === "success") return "bg-success/15 text-success"
    if (status === "failed") return "bg-destructive/15 text-destructive"
    if (status === "processing") return "bg-primary/10 text-primary"
    return "bg-muted text-foreground"
  }

  const loadPendingOrders = async () => {
    try {
      setLoadingPending(true)
      console.log("Fetching pending orders from API...")
      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch("/api/admin/orders/pending", {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || "Failed to load pending orders")
      }

      const result = await response.json()
      const ordersData = result.data || []
      const trueCount = result.trueCount ?? ordersData.length
      setPendingOrders(ordersData)
      setPendingTrueCount(trueCount)
      // Sync true pending count to localStorage for sidebar badge
      localStorage.setItem('adminPendingOrdersCount', trueCount.toString())
      console.log('[ADMIN-ORDERS] Updated localStorage with admin pending count:', trueCount)
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
      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch("/api/admin/orders/batches", {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      })

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
          orders: batch.orders || [],
          downloadedByEmail: batch.downloaded_by_email || undefined
        }
      })

      // Fetch current statuses for all orders
      const allOrderIds = result.data?.flatMap((batch: any) => batch.orders?.map((o: any) => o.id) || []) || []
      if (allOrderIds.length > 0) {
        console.log("[LOADED-ORDERS] Fetching current statuses for", allOrderIds.length, "orders")
        try {
          const { data: { session: statusSession } } = await supabase.auth.getSession()
          const statusResponse = await fetch("/api/admin/orders/batch-statuses", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(statusSession?.access_token ? { Authorization: `Bearer ${statusSession.access_token}` } : {}),
            },
            body: JSON.stringify({ orderIds: allOrderIds })
          })

          if (statusResponse.ok) {
            const { statusMap } = await statusResponse.json()
            console.log("[LOADED-ORDERS] Received status map for", Object.keys(statusMap).length, "orders")

            // Update orders with current statuses from database
            Object.keys(grouped).forEach((batchKey) => {
              grouped[batchKey].orders.forEach((order: any) => {
                if (statusMap[order.id]) {
                  console.log(`[LOADED-ORDERS] Order ${order.id} status from DB: ${statusMap[order.id]}, was: ${order.status}`)
                  order.status = statusMap[order.id]
                } else {
                  console.log(`[LOADED-ORDERS] Order ${order.id} not found in status map, keeping batch status: ${order.status}`)
                }
              })
            })
          } else {
            console.warn("[LOADED-ORDERS] Failed to fetch order statuses, using cached data from batch")
          }
        } catch (statusError) {
          console.warn("[LOADED-ORDERS] Error fetching statuses:", statusError, "using cached data from batch")
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

  const loadPendingMTNOrders = async () => {
    try {
      setLoadingMTNOrders(true)
      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch("/api/admin/fulfillment/manual-fulfill", {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || "Failed to load pending MTN orders")
      }

      const result = await response.json()
      console.log("Fetched pending MTN orders:", result.count)
      setPendingMTNOrders(result.orders || [])

      // Initialize status map
      const statusMap: { [key: string]: string } = {}
      result.orders?.forEach((order: any) => {
        statusMap[order.id] = "pending"
      })
      setMTNFulfillmentStatus(statusMap)
    } catch (error) {
      console.error("Error loading pending MTN orders:", error)
      toast.error(error instanceof Error ? error.message : "Failed to load pending MTN orders")
      setPendingMTNOrders([])
    } finally {
      setLoadingMTNOrders(false)
    }
  }

  // Manual-fulfill a single order straight from the pending list â€” used for `reversed`
  // orders (a provider flipped a completed order back to failed). Unlike handleManualFulfill,
  // it takes the order directly (pending-list rows aren't in pendingMTNOrders). Reuses the
  // MTN-fulfill button state for feedback.
  const handleReversedFulfill = async (order: ShopOrder) => {
    try {
      setFulfillingMTNOrder(order.id)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Session expired. Please refresh the page.")
        return
      }
      const response = await fetch("/api/admin/fulfillment/manual-fulfill", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
        body: JSON.stringify({ shop_order_id: order.id, order_type: (order as any).type || "shop", network: order.network }),
      })
      const json = await response.json()
      if (response.ok && json.success) {
        setMTNFulfillmentStatus(prev => ({ ...prev, [order.id]: "fulfilled" }))
        toast.success("Fulfillment queued")
        await loadPendingOrders()
      } else {
        setMTNFulfillmentStatus(prev => ({ ...prev, [order.id]: "error" }))
        toast.error(json.error || "Fulfillment failed")
      }
    } catch (e) {
      setMTNFulfillmentStatus(prev => ({ ...prev, [order.id]: "error" }))
      toast.error("Fulfillment failed")
    } finally {
      setFulfillingMTNOrder(null)
    }
  }

  const handleManualFulfill = async (orderId: string, provider?: string) => {
    try {
      setFulfillingMTNOrder(orderId)

      // Find the order to get network and other details
      const order = pendingMTNOrders.find(o => o.id === orderId)
      if (!order) {
        toast.error("Order not found")
        return
      }

      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Session expired. Please refresh the page.")
        return
      }

      const response = await fetch("/api/admin/fulfillment/manual-fulfill", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          shop_order_id: orderId,
          order_type: (order as any).type || "shop",
          network: order.network,
          ...(provider ? { provider } : {}),
        })
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || "Failed to fulfill order")
      }

      const result = await response.json()

      // Update status
      setMTNFulfillmentStatus(prev => ({
        ...prev,
        [orderId]: "fulfilled"
      }))

      // Remove from pending list
      setPendingMTNOrders(prev => prev.filter(o => o.id !== orderId))

      toast.success(`Order ${orderId} fulfilled successfully`)

      // Reload the list
      await loadPendingMTNOrders()
    } catch (error) {
      console.error("Error fulfilling order:", error)

      // Update status to show error
      setMTNFulfillmentStatus(prev => ({
        ...prev,
        [orderId]: "error"
      }))

      toast.error(error instanceof Error ? error.message : "Failed to fulfill order")

      // Refresh list â€” the order may no longer be truly pending (auto-fulfilled, already
      // completed via webhook, or status was just reconciled). This clears stale entries.
      loadPendingMTNOrders()
    } finally {
      setFulfillingMTNOrder(null)
    }
  }

  const updateStep = (steps: ProgressStep[], idx: number, patch: Partial<ProgressStep>): ProgressStep[] =>
    steps.map((s, i) => i === idx ? { ...s, ...patch } : s)

  const startFulfillWithProgress = async (order: any, provider: string) => {
    const phone = order.customer_phone || order.phone_number || "unknown"
    const initialSteps: ProgressStep[] = [
      { label: `Checking ${phone} against ${provider}`, status: "running" },
      { label: "Dispatching order", status: "idle" },
    ]
    setFulfillProgress({ open: true, orderId: order.id, orderType: order.type || "shop", phone, provider, steps: initialSteps, done: false })

    const { data: { session } } = await supabase.auth.getSession()
    const headers = { "Content-Type": "application/json", ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) }

    // Step 1 â€” whitelist verify
    let allowedBy: string | null = null
    try {
      const vRes = await fetch("/api/admin/fulfillment/verify-whitelist", {
        method: "POST", headers, body: JSON.stringify({ phone, primaryProvider: provider }),
      })
      const vData = await vRes.json()

      if (vData.results?.length) {
        // Expand steps: one per provider that was checked
        const verifySteps: ProgressStep[] = vData.results.map((r: { provider: string; allowed: boolean; reason?: string }) => ({
          label: `Verified against ${r.provider}`,
          status: r.allowed ? "done" : "error",
          detail: r.allowed ? "âœ“ Number is enabled" : `âœ— Blocked${r.reason ? `: ${r.reason}` : ""}`,
        }))
        setFulfillProgress(prev => ({
          ...prev,
          steps: [...verifySteps, { label: "Dispatching order", status: vData.allowed ? "running" : "error" }],
        }))
        allowedBy = vData.allowedBy ?? null
        if (!vData.allowed) {
          setFulfillProgress(prev => ({
            ...prev,
            steps: prev.steps.map((s, i) => i === prev.steps.length - 1 ? { ...s, detail: "All providers blocked â€” order will be held for retry" } : s),
            done: true,
          }))
          await loadPendingMTNOrders()
          return
        }
      } else {
        // No providers configured â€” skip to dispatch
        setFulfillProgress(prev => ({
          ...prev,
          steps: [
            { label: "Whitelist check", status: "done", detail: "No providers configured â€” skipped" },
            { label: "Dispatching order", status: "running" },
          ],
        }))
        allowedBy = provider
      }
    } catch {
      setFulfillProgress(prev => ({
        ...prev,
        steps: [
          { label: `Verify against ${provider}`, status: "error", detail: "Check failed â€” proceeding (fail-open)" },
          { label: "Dispatching order", status: "running" },
        ],
      }))
      allowedBy = provider
    }

    // Step 2 â€” dispatch via the provider that allowed the number
    const dispatchProvider = allowedBy ?? provider
    try {
      const dRes = await fetch("/api/admin/fulfillment/manual-fulfill", {
        method: "POST",
        headers,
        body: JSON.stringify({ shop_order_id: order.id, order_type: order.type || "shop", provider: dispatchProvider }),
      })
      const dData = await dRes.json()
      setFulfillProgress(prev => ({
        ...prev,
        steps: prev.steps.map((s, i) => i === prev.steps.length - 1
          ? { ...s, status: dData.success ? "done" : "error", detail: dData.message || dData.error }
          : s),
        done: true,
      }))
      if (dData.success) {
        setMTNFulfillmentStatus(prev => ({ ...prev, [order.id]: "fulfilled" }))
        await loadPendingMTNOrders()
      } else {
        setMTNFulfillmentStatus(prev => ({ ...prev, [order.id]: "error" }))
      }
    } catch (e) {
      setFulfillProgress(prev => ({
        ...prev,
        steps: prev.steps.map((s, i) => i === prev.steps.length - 1 ? { ...s, status: "error", detail: "Dispatch request failed" } : s),
        done: true,
      }))
      setMTNFulfillmentStatus(prev => ({ ...prev, [order.id]: "error" }))
    }
  }

  const handleDownloadOrders = async () => {
    if (pendingOrders.length === 0) {
      toast.error("No pending orders to download")
      return
    }

    // Show loading state while refreshing data
    setDownloading(true)

    try {
      // Reload pending orders to ensure fresh data
      await loadPendingOrders()

      // Open network selection dialog
      setSelectedNetworks([]) // Reset selection
      setShowNetworkSelection(true)
    } finally {
      setDownloading(false)
    }
  }

  const handleConfirmDownload = async () => {
    if (selectedNetworks.length === 0) {
      toast.error("Please select at least one network")
      return
    }

    try {
      setDownloading(true)

      // Fetch fresh pending orders to include any new orders that came in
      const { data: { session: pendingSession } } = await supabase.auth.getSession()
      const pendingResponse = await fetch("/api/admin/orders/pending", {
        headers: pendingSession?.access_token ? { Authorization: `Bearer ${pendingSession.access_token}` } : {},
      })
      if (!pendingResponse.ok) {
        throw new Error("Failed to fetch latest orders")
      }
      const result = await pendingResponse.json()
      const freshOrders = result.data || []

      // Filter fresh orders by selected networks
      const filteredOrders = freshOrders.filter((o: any) => selectedNetworks.includes(o.network))

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
          orderIds: filteredOrders.map((o: any) => o.id),
          combineDuplicates,
        })
      })

      if (!response.ok) {
        let errorMessage = "Failed to download orders"
        let isConflict = false
        try {
          const errorData = await response.json()
          errorMessage = errorData.error || errorMessage
          isConflict = errorData.alreadyDownloaded === true || response.status === 409
        } catch (e) {
          // If response isn't JSON, use status text
          errorMessage = response.statusText || errorMessage
        }

        // If orders were already downloaded by another admin, show specific message and refresh
        if (isConflict) {
          toast.error("These orders were already downloaded by another admin. Refreshing list...")
          await loadPendingOrders()
          setShowNetworkSelection(false)
          return
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

  const handleExportPhoneNumbers = async () => {
    setExporting(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Session expired. Please sign in again.")
        return
      }
      const response = await fetch("/api/admin/orders/phone-export", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err.error || "Failed to export phone numbers")
      }
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const element = document.createElement("a")
      element.setAttribute("href", url)
      element.setAttribute("download", `order-phones-${new Date().toISOString().split("T")[0]}.xlsx`)
      element.style.display = "none"
      document.body.appendChild(element)
      element.click()
      document.body.removeChild(element)
      window.URL.revokeObjectURL(url)
      toast.success("Exported all-time order phone numbers by network.")
    } catch (error) {
      console.error("Error exporting phone numbers:", error)
      toast.error(error instanceof Error ? error.message : "Failed to export phone numbers")
    } finally {
      setExporting(false)
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

      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Authentication required. Please log in again.")
        return
      }

      const response = await fetch("/api/admin/orders/bulk-update-status", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
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

      const result = await response.json()
      
      if (result.skippedPending > 0) {
        toast.warning(`${result.skippedPending} pending order(s) skipped. Only processing orders can be marked as completed.`)
      }

      const updatedCount = batch.orders.length - (result.skippedPending || 0)
      if (updatedCount > 0) {
        toast.success(`Updated ${updatedCount} orders to ${newStatus}`)
      }

      // Reload orders to get fresh state including statuses
      await loadDownloadedOrders()
      await loadPendingOrders()
    } catch (error) {
      console.error("Error updating batch status:", error)
      toast.error(error instanceof Error ? error.message : "Failed to update status")
    } finally {
      setUpdatingBatch(null)
    }
  }

  const handleBulkManualFulfill = async () => {
    if (pendingMTNOrders.length === 0) {
      toast.error("No pending MTN orders to fulfill")
      return
    }

    try {
      setLoadingMTNOrders(true)
      const { data: { session } } = await supabase.auth.getSession()
      
      if (!session?.access_token) {
        toast.error("Session expired. Please refresh.")
        return
      }

      // No explicit provider â€” every order uses the admin-selected provider
      // (admin_settings.mtn_provider_selection) resolved server-side.
      const orders = pendingMTNOrders.slice(0, 1000).map(o => ({
        id: o.id,
        type: (o as any).type || 'shop',
      }))

      const response = await fetch("/api/admin/fulfillment/bulk-manual-fulfill", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ orders })
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || "Bulk fulfillment failed")
      }

      const result = await response.json()
      const { success: ok, failed } = result.summary ?? {}
      if (failed > 0 && ok === 0) {
        toast.error(`All ${failed} orders failed — they remain in the queue`)
      } else if (failed > 0) {
        toast.warning(`${ok} submitted, ${failed} failed — failed orders remain in the queue`)
      } else {
        toast.success(result.message)
      }

      // Reload lists
      await loadPendingMTNOrders()
      await loadPendingOrders()
    } catch (error) {
      console.error("Bulk fulfillment error:", error)
      toast.error(error instanceof Error ? error.message : "Bulk fulfillment failed")
    } finally {
      setLoadingMTNOrders(false)
    }
  }

  const handleBulkDeleteBatches = async () => {
    if (!deleteBatchesEndDate) {
      toast.error("Please select a date to delete batches before")
      return
    }

    // Confirm deletion
    const confirmed = confirm(
      `Are you sure you want to delete all batches before ${deleteBatchesEndDate}? This action cannot be undone.`
    )

    if (!confirmed) return

    try {
      setDeletingBatches(true)

      const response = await fetch("/api/admin/orders/delete-batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toDate: new Date(deleteBatchesEndDate).toISOString(),
        })
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || "Failed to delete batches")
      }

      const result = await response.json()
      toast.success(result.message || `Deleted ${result.deletedCount} batch(es)`)

      // Reset form and reload batches
      setDeleteBatchesEndDate("")
      await loadDownloadedOrders()
    } catch (error) {
      console.error("Error deleting batches:", error)
      toast.error(error instanceof Error ? error.message : "Failed to delete batches")
    } finally {
      setDeletingBatches(false)
    }
  }

  const getNetworkColor = (network: string) => {
    const colors: { [key: string]: string } = {
      "MTN": "bg-orange-100 text-orange-800 border-orange-200",
      "Telecel": "bg-red-100 text-red-800 border-red-200",
      "AT - iShare": "bg-primary/10 text-primary border-primary",
      "AT - BigTime": "bg-primary/10 text-primary border-primary",
    }
    return colors[network] || "bg-muted text-muted-foreground border-border"
  }

  const getFilteredDownloadedOrders = () => {
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
    const monthAgo = new Date(today.getFullYear(), today.getMonth() - 1, today.getDate())
    const threeMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 3, today.getDate())
    const searchLower = downloadedBatchSearch.toLowerCase().trim()

    return Object.entries(downloadedOrders).filter(([, batch]) => {
      const batchDate = new Date(batch.downloadedAt)
      const batchDateOnly = new Date(batchDate.getFullYear(), batchDate.getMonth(), batchDate.getDate())

      // Check search filter - search in phone numbers, admin email, or network
      if (searchLower) {
        const phoneMatch = batch.orders.some(o =>
          o.phone_number?.toLowerCase().includes(searchLower)
        )
        const adminMatch = batch.downloadedByEmail?.toLowerCase().includes(searchLower)
        const networkMatch = batch.network.toLowerCase().includes(searchLower)

        if (!phoneMatch && !adminMatch && !networkMatch) return false
      }

      // Check network filter
      if (downloadedNetworkFilter !== "all" && batch.network !== downloadedNetworkFilter) {
        return false
      }

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
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold bg-gradient-to-r from-red-600 via-primary to-pink-600 bg-clip-text text-transparent">
              Order Management
            </h1>
            <p className="text-muted-foreground mt-1 font-medium">Download and manage pending orders</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleExportPhoneNumbers} disabled={exporting}>
              {exporting ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Download className="h-4 w-4 mr-2" />
              )}
              {exporting ? "Exportingâ€¦" : "Download phone numbers"}
            </Button>
          </div>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "pending" | "downloaded" | "fulfillment")}>
          <TabsList className="grid w-full grid-cols-3 h-auto">
            <TabsTrigger value="pending" className="flex items-center justify-center gap-1 px-2 py-2 text-xs sm:text-sm">
              <Clock className="h-3 w-3 sm:h-4 sm:w-4 shrink-0" />
              <span className="hidden sm:inline">Pending</span>
              <span className="sm:hidden">Pend</span>
              <span>({formatCount(pendingTrueCount)})</span>
            </TabsTrigger>
            <TabsTrigger value="downloaded" className="flex items-center justify-center gap-1 px-2 py-2 text-xs sm:text-sm">
              <CheckCircle className="h-3 w-3 sm:h-4 sm:w-4 shrink-0" />
              <span className="hidden sm:inline">Downloaded</span>
              <span className="sm:hidden">DL</span>
              <span>({formatCount(Object.keys(downloadedOrders).length)})</span>
            </TabsTrigger>
            <TabsTrigger value="fulfillment" className="flex items-center justify-center gap-1 px-2 py-2 text-xs sm:text-sm">
              <Zap className="h-3 w-3 sm:h-4 sm:w-4 shrink-0" />
              <span className="hidden sm:inline">Fulfillment</span>
              <span className="sm:hidden">Fulfill</span>
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
                    className="bg-gradient-to-r from-blue-600 to-primary hover:from-blue-700 hover:to-primary text-primary-foreground font-semibold"
                  >
                    {downloading ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4 mr-2" />
                    )}
                    {downloading ? "Downloading..." : `Download All (${formatCount(pendingOrders.length)})`}
                  </Button>
                </div>

                {/* Orders Table */}
                <Card>
                  <CardHeader>
                    <CardTitle>Pending Orders</CardTitle>
                    <CardDescription>
                      {formatCount(pendingTrueCount)} order{pendingTrueCount !== 1 ? "s" : ""} waiting to be downloaded
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <table className="min-w-[600px] w-full text-xs sm:text-sm">
                        <thead className="bg-muted border-b">
                          <tr>
                            <th className="px-2 sm:px-4 py-2 text-left font-semibold text-foreground whitespace-nowrap">Order ID</th>
                            <th className="px-2 sm:px-4 py-2 text-left font-semibold text-foreground whitespace-nowrap">Type</th>
                            <th className="px-2 sm:px-4 py-2 text-left font-semibold text-foreground whitespace-nowrap">Network</th>
                            <th className="px-2 sm:px-4 py-2 text-left font-semibold text-foreground whitespace-nowrap">Package</th>
                            <th className="px-2 sm:px-4 py-2 text-left font-semibold text-foreground whitespace-nowrap">Phone</th>
                            <th className="px-2 sm:px-4 py-2 text-right font-semibold text-foreground whitespace-nowrap">Price (GHS)</th>
                            <th className="px-2 sm:px-4 py-2 text-center font-semibold text-foreground whitespace-nowrap">Date</th>
                            <th className="px-2 sm:px-4 py-2 text-center font-semibold text-foreground whitespace-nowrap">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {pendingOrders.map((order) => (
                            <tr key={order.id} className="hover:bg-muted/40">
                              <td className="px-2 sm:px-4 py-3 font-mono text-xs font-semibold break-all max-w-[120px]">{order.id}</td>
                              <td className="px-2 sm:px-4 py-3">
                                <Badge variant="outline" className={`text-xs capitalize ${
                                  order.type === 'api' ? 'bg-primary/10 text-primary border-primary' :
                                  order.type === 'bulk' ? 'bg-primary/10 text-primary border-primary' :
                                  'bg-warning/10 text-warning border-warning/30'
                                }`}>
                                  {order.type || 'Shop'}
                                </Badge>
                              </td>
                              <td className="px-2 sm:px-4 py-3">
                                <Badge className={`${getNetworkColor(order.network)} border text-xs`}>{order.network}</Badge>
                              </td>
                              <td className="px-2 sm:px-4 py-3">{order.size}GB</td>
                              <td className="px-2 sm:px-4 py-3 font-mono text-xs break-all max-w-[120px]">{order.phone_number}</td>
                              <td className="px-2 sm:px-4 py-3 text-right font-semibold">â‚µ {(order.price || 0).toFixed(2)}</td>
                              <td className="px-2 sm:px-4 py-3 text-center text-xs text-muted-foreground">
                                <div>{new Date(order.created_at).toLocaleDateString()}</div>
                                <div className="text-xs text-muted-foreground">{new Date(order.created_at).toLocaleTimeString()}</div>
                              </td>
                              <td className="px-2 sm:px-4 py-3 text-center">
                                {order.status === "reversed" ? (
                                  <div className="flex flex-col items-center gap-1">
                                    <Badge className="bg-warning/15 text-warning border border-warning/30 text-xs">Reversed</Badge>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-7 text-xs whitespace-nowrap"
                                      onClick={() => handleReversedFulfill(order)}
                                      disabled={fulfillingMTNOrder === order.id || mtnFulfillmentStatus[order.id] === "fulfilled"}
                                    >
                                      {fulfillingMTNOrder === order.id ? (
                                        <><Loader2 className="h-3 w-3 mr-1 animate-spin" />Fulfillingâ€¦</>
                                      ) : mtnFulfillmentStatus[order.id] === "fulfilled" ? (
                                        <><CheckCircle className="h-3 w-3 mr-1" />Fulfilled</>
                                      ) : (
                                        <><Send className="h-3 w-3 mr-1" />Manual fulfill</>
                                      )}
                                    </Button>
                                  </div>
                                ) : (
                                  <Badge variant="outline" className="text-xs bg-muted text-muted-foreground border-border">Pending</Badge>
                                )}
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
                {/* Search and Network Filter */}
                <Card>
                  <CardHeader>
                    <CardTitle>Search Downloaded Batches</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <input
                          type="text"
                          placeholder="Search by phone, admin email, or network..."
                          value={downloadedBatchSearch}
                          onChange={(e) => setDownloadedBatchSearch(e.target.value)}
                          className="w-full pl-10 pr-4 py-2 border border-border rounded-md focus:ring-2 focus:ring-primary focus:border-transparent"
                        />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant={downloadedNetworkFilter === "all" ? "default" : "outline"}
                          onClick={() => setDownloadedNetworkFilter("all")}
                          size="sm"
                        >
                          All Networks
                        </Button>
                        {allNetworks.map((network) => (
                          <Button
                            key={network}
                            variant={downloadedNetworkFilter === network ? "default" : "outline"}
                            onClick={() => setDownloadedNetworkFilter(network)}
                            size="sm"
                          >
                            {network}
                          </Button>
                        ))}
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Date Filter */}
                <Card>
                  <CardHeader>
                    <CardTitle>Filter by Date</CardTitle>
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

                {/* Bulk Delete by Date Range */}
                <Card className="border-destructive/30 bg-destructive/10">
                  <CardContent className="pt-4 pb-4">
                    <div className="flex flex-col sm:flex-row gap-2 items-end">
                      <div className="flex-1">
                        <label className="block text-xs font-medium text-foreground mb-1">Delete batches before date</label>
                        <input
                          type="date"
                          value={deleteBatchesEndDate}
                          onChange={(e) => setDeleteBatchesEndDate(e.target.value)}
                          className="w-full px-3 py-2 border border-border rounded-md text-sm focus:ring-2 focus:ring-destructive focus:border-transparent"
                        />
                      </div>
                      <Button
                        onClick={handleBulkDeleteBatches}
                        disabled={deletingBatches || !deleteBatchesEndDate}
                        size="sm"
                        className="bg-destructive hover:bg-destructive/90 text-primary-foreground w-full sm:w-auto"
                      >
                        {deletingBatches ? (
                          <>
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            Deleting...
                          </>
                        ) : (
                          "Delete"
                        )}
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
                    <Card key={batchKey} className="border-l-4 border-l-success">
                      <CardHeader>
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                          <div>
                            <CardTitle className="flex items-center gap-2">
                              <Badge className="bg-success/15 text-success border border-success/30">
                                {batch.network}
                              </Badge>
                              <span className="text-muted-foreground">Batch</span>
                            </CardTitle>
                            <CardDescription>
                              Downloaded: {new Date(batch.downloadedAt).toLocaleString()}
                              {batch.downloadedByEmail && (
                                <span className="ml-2 text-blue-600">by {batch.downloadedByEmail}</span>
                              )}
                            </CardDescription>
                          </div>
                          <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full sm:w-auto">
                            <Badge className="bg-blue-100 text-blue-800 border border-blue-200 text-lg px-3 py-1 w-full sm:w-auto text-center">
                              {formatCount(batch.orders.length)} orders
                            </Badge>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleRedownloadBatch(batchKey)}
                              disabled={updatingBatch === batchKey}
                              className="w-full sm:w-auto"
                            >
                              {updatingBatch === batchKey ? (
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                              ) : (
                                <Download className="h-4 w-4 mr-2" />
                              )}
                              {updatingBatch === batchKey ? "Downloading..." : "Redownload"}
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
                            </select>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead className="bg-muted border-b">
                              <tr>
                                <th className="px-2 sm:px-4 py-2 text-left font-semibold text-foreground text-xs sm:text-sm">Order ID</th>
                                <th className="px-2 sm:px-4 py-2 text-left font-semibold text-foreground text-xs sm:text-sm">Type</th>
                                 <th className="px-2 sm:px-4 py-2 text-left font-semibold text-foreground text-xs sm:text-sm">Network</th>
                                <th className="px-2 sm:px-4 py-2 text-left font-semibold text-foreground text-xs sm:text-sm">Package</th>
                                <th className="px-2 sm:px-4 py-2 text-left font-semibold text-foreground text-xs sm:text-sm">Phone</th>
                                <th className="px-2 sm:px-4 py-2 text-right font-semibold text-foreground text-xs sm:text-sm">Price (GHS)</th>
                                <th className="px-2 sm:px-4 py-2 text-center font-semibold text-foreground text-xs sm:text-sm">Status</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y">
                              {batch.orders.map((order: any) => (
                                <tr key={order.id} className="hover:bg-muted/40">
                                  <td className="px-2 sm:px-4 py-3 font-mono text-xs font-semibold">{order.id}</td>
                                  <td className="px-2 sm:px-4 py-3">
                                    <Badge variant="outline" className={`text-xs capitalize ${
                                       order.type === 'api' ? 'bg-primary/10 text-primary border-primary' :
                                       order.type === 'bulk' ? 'bg-primary/10 text-primary border-primary' :
                                       'bg-warning/10 text-warning border-warning/30'
                                     }`}>
                                       {order.type || 'Shop'}
                                     </Badge>
                                   </td>
                                   <td className="px-2 sm:px-4 py-3">
                                     <Badge className={`${getNetworkColor(order.network)} border text-xs`}>
                                      {order.network}
                                    </Badge>
                                  </td>
                                  <td className="px-2 sm:px-4 py-3 text-xs sm:text-sm">{order.size}GB</td>
                                  <td className="px-2 sm:px-4 py-3 font-mono text-xs">{order.phone_number}</td>
                                  <td className="px-2 sm:px-4 py-3 text-right font-semibold text-xs sm:text-sm">â‚µ {(order.price || 0).toFixed(2)}</td>
                                  <td className="px-2 sm:px-4 py-3 text-center">
                                    <Badge className={`border text-xs ${order.status === "completed" ? "bg-success/15 text-success border-success/30" :
                                      order.status === "failed" ? "bg-destructive/15 text-destructive border-destructive/30" :
                                        order.status === "processing" ? "bg-blue-100 text-blue-800 border-blue-200" :
                                          order.status ? "bg-muted text-muted-foreground border-border" :
                                            "bg-warning/15 text-warning border-warning/30"
                                      }`}>
                                      {order.status ? (order.status.charAt(0).toUpperCase() + order.status.slice(1)) : "Unknown"}
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

          <TabsContent value="fulfillment" className="space-y-4">
            {/* â”€â”€ Fulfillment log stats â”€â”€ */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              {[
                { label: "Total",      value: logStatusCounts?.total      ?? 0, cls: "" },
                { label: "Success",    value: logStatusCounts?.success    ?? 0, cls: "bg-success/10" },
                { label: "Failed",     value: logStatusCounts?.failed     ?? 0, cls: "bg-destructive/10" },
                { label: "Processing", value: logStatusCounts?.processing ?? 0, cls: "bg-primary/5" },
                { label: "Pending",    value: logStatusCounts?.pending    ?? 0, cls: "bg-muted/40" },
              ].map(s => (
                <Card key={s.label} className={s.cls}>
                  <CardContent className="pt-6 text-center">
                    <p className="text-3xl font-bold">{formatCount(s.value)}</p>
                    <p className="text-sm text-muted-foreground">{s.label}</p>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* â”€â”€ Filters + actions â”€â”€ */}
            <Card>
              <CardHeader><CardTitle>Filters</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  {(["all", "success", "failed", "processing", "pending"] as const).map(s => (
                    <Button key={s} variant={logFilter === s ? "default" : "outline"} size="sm"
                      onClick={() => { setLogFilter(s); setLogPage(1) }} className="capitalize">{s}</Button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Input placeholder="Search by phoneâ€¦" value={logSearchPhone}
                    onChange={e => setLogSearchPhone(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") { setLogCommittedPhone(logSearchPhone); setLogPage(1) } }}
                    className="flex-1 min-w-[180px]" />
                  <Button size="sm" onClick={() => { setLogCommittedPhone(logSearchPhone); setLogPage(1) }}>Search</Button>
                  <Button size="sm" variant="outline" onClick={() => loadFulfillmentLogs(logPage)}>
                    <RefreshCw className="w-4 h-4 mr-1" />Refresh
                  </Button>
                  <Button size="sm" variant="outline" disabled={logSyncingCodecraft} onClick={handleLogSyncCodecraft}
                    className="border-border text-primary hover:bg-primary/20">
                    {logSyncingCodecraft ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : <Zap className="w-4 h-4 mr-1" />}
                    {logSyncingCodecraft ? "Syncingâ€¦" : "Sync Codecraft"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={handleLogDownloadReport}>
                    <Download className="w-4 h-4 mr-1" />Export
                  </Button>
                  <Button size="sm" variant="destructive" disabled={logDeleting === "bulk"} onClick={handleLogBulkDeleteFailed}>
                    {logDeleting === "bulk" ? <Clock className="w-4 h-4 mr-1 animate-spin" /> : <Trash2 className="w-4 h-4 mr-1" />}
                    Clear Failed
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* â”€â”€ Log table â”€â”€ */}
            <Card>
              <CardHeader>
                <CardTitle>Fulfillment Orders</CardTitle>
                <CardDescription>
                  {logPagination
                    ? `Showing ${(logPage - 1) * logPagination.limit + 1}â€“${Math.min(logPage * logPagination.limit, logPagination.total)} of ${formatCount(logPagination.total)} orders`
                    : "Loadingâ€¦"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {logLoading ? (
                  <div className="text-center py-8 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin mx-auto" /></div>
                ) : logFulfillments.length === 0 ? (
                  <Alert><AlertCircle className="h-4 w-4" /><AlertDescription>No fulfillments found</AlertDescription></Alert>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b">
                          {["Status","Order ID","Phone","Attempts","Created","Error","Action"].map(h => (
                            <th key={h} className="text-left py-3 px-4 font-semibold">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {logFulfillments.map(f => (
                          <tr key={f.id} className="border-b hover:bg-accent">
                            <td className="py-3 px-4">
                              <div className="flex items-center gap-2">
                                {getLogStatusIcon(f.status)}
                                <Badge className={getLogStatusColor(f.status)}>{f.status}</Badge>
                              </div>
                            </td>
                            <td className="py-3 px-4">
                              <code className="text-xs bg-muted px-2 py-1 rounded">{f.order_id.substring(0, 8)}â€¦</code>
                            </td>
                            <td className="py-3 px-4">{f.phone_number}</td>
                            <td className="py-3 px-4">{f.attempt_number}/{f.max_attempts}</td>
                            <td className="py-3 px-4 text-xs">{new Date(f.created_at).toLocaleString()}</td>
                            <td className="py-3 px-4 text-xs">
                              {f.error_message
                                ? <span className="max-w-xs text-destructive truncate block">{f.error_message}</span>
                                : "-"}
                            </td>
                            <td className="py-3 px-4">
                              {f.status === "failed" && f.attempt_number < f.max_attempts && (
                                <Button size="sm" disabled={logRetrying === f.order_id || logDeleting === "bulk"}
                                  onClick={() => handleLogRetry(f.order_id)}>
                                  {logRetrying === f.order_id ? "Retryingâ€¦" : "Retry"}
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {logPagination && logPagination.totalPages > 1 && (
                      <div className="flex items-center justify-between pt-4 border-t mt-2">
                        <span className="text-xs text-muted-foreground">
                          Page {logPage} of {logPagination.totalPages} â€” {formatCount(logPagination.total)} total
                        </span>
                        <div className="flex gap-2">
                          <Button variant="outline" size="sm" disabled={logPage <= 1 || logLoading}
                            onClick={() => loadFulfillmentLogs(logPage - 1)}>Previous</Button>
                          <Button variant="outline" size="sm" disabled={logPage >= logPagination.totalPages || logLoading}
                            onClick={() => loadFulfillmentLogs(logPage + 1)}>Next</Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

          </TabsContent>
        </Tabs>

        {/* Fulfill Progress Dialog */}
        <Dialog open={fulfillProgress.open} onOpenChange={open => !open && setFulfillProgress(prev => ({ ...prev, open: false }))}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-warning" />
                Fulfilling Order
              </DialogTitle>
              <DialogDescription>
                {fulfillProgress.phone} via <span className="font-semibold capitalize">{fulfillProgress.provider}</span>
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              {fulfillProgress.steps.map((step, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="mt-0.5 shrink-0">
                    {step.status === "running" && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                    {step.status === "done"    && <CheckCircle className="h-4 w-4 text-success" />}
                    {step.status === "error"   && <AlertCircle className="h-4 w-4 text-destructive" />}
                    {step.status === "idle"    && <Clock className="h-4 w-4 text-muted-foreground" />}
                  </div>
                  <div>
                    <p className={`text-sm font-medium ${
                      step.status === "done" ? "text-success" :
                      step.status === "error" ? "text-destructive" :
                      step.status === "running" ? "text-foreground" :
                      "text-muted-foreground"
                    }`}>{step.label}</p>
                    {step.detail && <p className="text-xs text-muted-foreground mt-0.5">{step.detail}</p>}
                  </div>
                </div>
              ))}
            </div>
            {fulfillProgress.done && (
              <DialogFooter>
                <Button variant="outline" onClick={() => setFulfillProgress(prev => ({ ...prev, open: false }))}>
                  Close
                </Button>
              </DialogFooter>
            )}
          </DialogContent>
        </Dialog>

        {/* Network Selection Dialog */}
        <Dialog open={showNetworkSelection} onOpenChange={setShowNetworkSelection}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Select Networks to Download</DialogTitle>
              <DialogDescription>
                Choose which networks you want to download orders for.
                {pendingTrueCount > 0 && (
                  <span className="block mt-2 text-sm">
                    Available orders: {formatCount(pendingTrueCount)}
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
                    className={`w-full flex items-center gap-3 p-3 rounded border-2 transition-all ${isSelected
                      ? 'bg-blue-50 border-blue-500'
                      : 'bg-card border-border hover:border-border'
                      } ${isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    <div className={`flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center ${isSelected
                      ? 'bg-blue-500 border-blue-500'
                      : 'border-border bg-card'
                      }`}>
                      {isSelected && <Check className="w-4 h-4 text-primary-foreground" />}
                    </div>
                    <div className="flex-1 text-left">
                      <span className="font-medium text-foreground">{network}</span>
                      <span className="text-sm text-muted-foreground ml-2">
                        ({formatCount(networkOrderCount)} order{networkOrderCount !== 1 ? 's' : ''})
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>

            {/* Combine-duplicates toggle: sum a number's multiple orders into one row */}
            <button
              type="button"
              onClick={() => setCombineDuplicates(v => !v)}
              className="w-full flex items-start gap-3 p-3 mt-2 rounded border-2 border-border bg-card text-left hover:border-blue-400 transition-all"
            >
              {combineDuplicates ? (
                <ToggleRight className="h-6 w-6 flex-shrink-0 text-blue-600" />
              ) : (
                <ToggleLeft className="h-6 w-6 flex-shrink-0 text-muted-foreground" />
              )}
              <div className="flex-1">
                <span className="font-medium text-foreground">Combine duplicate numbers</span>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {combineDuplicates
                    ? "A number with several orders is exported once, with the gigs added together (e.g. 1 + 2 + 2 â†’ 5GB)."
                    : "One row per order â€” a number with several orders is listed multiple times. Use for suppliers that only accept fixed pack sizes."}
                </p>
              </div>
            </button>

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
                className="bg-gradient-to-r from-blue-600 to-primary hover:from-blue-700 hover:to-primary text-primary-foreground"
              >
                {downloading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Downloading...
                  </>
                ) : (
                  "Download Selected"
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  )
}
