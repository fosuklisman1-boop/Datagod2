"use client"

import { Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, Loader2, Zap, CheckCircle, Clock, ChevronDown, ShieldCheck, Send, SlidersHorizontal } from "lucide-react"
import { useAdminProtected } from "@/hooks/use-admin"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { PageHeaderBanner } from "@/components/shared/page-header-banner"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { QueueTabs } from "@/components/admin/order-queue/queue-tabs"
import { FilterPanel } from "@/components/admin/order-queue/filter-panel"
import { QueueTable } from "@/components/admin/order-queue/queue-table"
import { ActionsMenu, BulkToolDialog } from "@/components/admin/order-queue/actions-menu"
import { BulkActionBar } from "@/components/admin/order-queue/bulk-action-bar"
import { ACK_MISMATCH_COPY, SendConfirmDialog } from "@/components/admin/order-queue/send-confirm-dialog"
import { SendResults, type SendResultData } from "@/components/admin/order-queue/send-results"
import { AutoFulfilPanel } from "@/components/admin/order-queue/auto-fulfil-panel"
import { getProviderOptionsForNetwork, suppliersForNetworks, type SupplierOption } from "@/lib/order-queue/supplier-capability"
import { buildSendBody, parseSupplierBalances, summarizeSelection, type SelectionSummary } from "@/lib/order-queue/confirm-summary"
import { emptySelection, selectionReducer, SELECTION_CAP } from "@/lib/order-queue/selection"
import { EXPORT_COLUMNS, queueRowsToSheetRows } from "@/lib/order-queue/export"
import { parseQueueParams, queueParamsToSearch } from "@/lib/order-queue/params"
import { makeQueueReloader } from "@/lib/order-queue/reload"
import type { QueueParams, QueueRow, QueueView } from "@/lib/order-queue/types"

const PAGE_SIZE = 50

function defaultParams(): QueueParams {
  const r = parseQueueParams(new URLSearchParams())
  if (!r.ok) throw new Error("default queue params must parse")
  return r.value
}

/** URL form of the filters: paging is local (Load more), so limit/offset never go in the URL. */
const filterSearch = (p: QueueParams) => queueParamsToSearch({ ...p, limit: PAGE_SIZE, offset: 0 })

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}
}

type QueueResponse = {
  success?: boolean
  data?: QueueRow[]
  counts?: Record<QueueView, number>
  total?: number
  hasMore?: boolean
  error?: string
}

async function fetchQueue(p: QueueParams): Promise<Required<Omit<QueueResponse, "error">>> {
  const res = await fetch(`/api/admin/orders/queue?${queueParamsToSearch(p)}`, { headers: await authHeaders() })
  const body: QueueResponse = await res.json().catch(() => ({}))
  if (!res.ok || !body.success) throw new Error(body.error || "Failed to load the order queue")
  return {
    success: true,
    data: body.data ?? [],
    counts: body.counts as Record<QueueView, number>,
    total: body.total ?? 0,
    hasMore: Boolean(body.hasMore),
  }
}

export default function OrderPaymentStatusPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <OrderPaymentStatusPageInner />
    </Suspense>
  )
}

function OrderPaymentStatusPageInner() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { isAdmin, loading: adminLoading } = useAdminProtected()

  // ── Filters live in the URL (shareable views) ──
  const urlKey = searchParams.toString()
  const params = useMemo(() => {
    const r = parseQueueParams(new URLSearchParams(urlKey))
    return r.ok ? { ...r.value, limit: PAGE_SIZE, offset: 0 } : defaultParams()
  }, [urlKey])
  const filterKey = filterSearch(params)
  const setParams = useCallback(
    (next: QueueParams) => {
      const qs = filterSearch(next)
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [router, pathname],
  )
  const [showFilters, setShowFilters] = useState(false)

  // ── Queue data ──
  const [rows, setRows] = useState<QueueRow[]>([])
  const [counts, setCounts] = useState<Record<QueueView, number> | null>(null)
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingQueue, setLoadingQueue] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const nextOffset = useRef(0)
  const requestSeq = useRef(0)

  const [selection, dispatchSelection] = useReducer(selectionReducer, undefined, emptySelection)
  const [exporting, setExporting] = useState(false)

  // ── Send selected orders to a chosen supplier ──
  /** Rows behind an "all matching" selection (≤ SELECTION_CAP), fetched once when it is switched on. */
  const [allMatchingRows, setAllMatchingRows] = useState<QueueRow[] | null>(null)
  const [balances, setBalances] = useState<Record<string, string>>({})
  const balancesRequested = useRef(false)
  const [sendSupplier, setSendSupplier] = useState<SupplierOption | null>(null)
  /** The selection as it was when the dialog opened: what the admin confirms is exactly what is sent. */
  const [sendSummary, setSendSummary] = useState<SelectionSummary | null>(null)
  const [ackTyped, setAckTyped] = useState("")
  const [ackChecked, setAckChecked] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sendResult, setSendResult] = useState<SendResultData | null>(null)
  const [barStatusUpdating, setBarStatusUpdating] = useState(false)

  const [updatingOrderId, setUpdatingOrderId] = useState<string | null>(null)
  const [fulfillingOrderId, setFulfillingOrderId] = useState<string | null>(null)
  const [autoFulfillmentEnabled, setAutoFulfillmentEnabled] = useState(false)

  type ProgressStep = { label: string; status: "idle" | "running" | "done" | "error"; detail?: string }
  const [fulfillProgress, setFulfillProgress] = useState<{
    open: boolean; orderId: string; orderType: string; phone: string; provider: string
    steps: ProgressStep[]; done: boolean
  }>({ open: false, orderId: "", orderType: "", phone: "", provider: "", steps: [], done: false })

  // MTN Fulfillment state
  const [pendingMTNOrders, setPendingMTNOrders] = useState<any[]>([])
  const [loadingMTNOrders, setLoadingMTNOrders] = useState(false)
  // IDs sent in a previous batch this session — excluded from the next slice so
  // a persistently-failing batch can't block orders behind it in the queue.
  // Resets on page reload, giving failed orders a fresh attempt.
  const [skipIds, setSkipIds] = useState<Set<string>>(new Set())
  // Queue-based fulfillment progress
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null)
  const [batchProgress, setBatchProgress] = useState<{
    total: number; pending: number; processing: number; completed: number; failed: number
  } | null>(null)

  // Bulk update state (the date-range tool, now under the Actions menu)
  const [showBulkUpdate, setShowBulkUpdate] = useState(false)
  const [bulkDate, setBulkDate] = useState("")
  const [bulkStartTime, setBulkStartTime] = useState("")
  const [bulkEndTime, setBulkEndTime] = useState("")
  const [bulkNetwork, setBulkNetwork] = useState("")
  const [bulkStatus, setBulkStatus] = useState("")
  const [bulkUpdating, setBulkUpdating] = useState(false)
  const [bulkDownloading, setBulkDownloading] = useState(false)
  const [bulkDownloadingFailed, setBulkDownloadingFailed] = useState(false)
  const [globalBulkCount, setGlobalBulkCount] = useState<number | null>(null)
  const [loadingBulkCount, setLoadingBulkCount] = useState(false)

  const loadQueue = useCallback(async (p: QueueParams, append: boolean) => {
    const seq = ++requestSeq.current
    const offset = append ? nextOffset.current : 0
    setLoadingQueue(true)
    if (!append) setLoadError(null)
    try {
      const r = await fetchQueue({ ...p, limit: PAGE_SIZE, offset })
      if (seq !== requestSeq.current) return // a newer request superseded this one
      nextOffset.current = offset + r.data.length
      setRows((prev) => {
        if (!append) return r.data
        const seen = new Set(prev.map((x) => x.id))
        return [...prev, ...r.data.filter((x) => !seen.has(x.id))]
      })
      setCounts(r.counts)
      setTotal(r.total)
      setHasMore(r.hasMore)
    } catch (error) {
      if (seq !== requestSeq.current) return
      const msg = error instanceof Error ? error.message : "Failed to load the order queue"
      if (!append) setLoadError(msg)
      toast.error(msg)
    } finally {
      if (seq === requestSeq.current) setLoadingQueue(false)
    }
  }, [])

  // Latest filters, read at call time so long-lived callbacks (the batch poll) never reload a stale view.
  const paramsRef = useRef(params)
  paramsRef.current = params

  /** Reload from the top with the current filters (selection cleared: the row set changes). */
  const reloadQueue = useMemo(
    () => makeQueueReloader(() => paramsRef.current, loadQueue, () => dispatchSelection({ type: "clear" })),
    [loadQueue],
  )

  useEffect(() => {
    if (isAdmin && !adminLoading) {
      loadAutoFulfillmentSetting()
      loadPendingMTNOrders()
    }
  }, [isAdmin, adminLoading])

  // Any filter or tab change: clear the selection and load page one.
  useEffect(() => {
    if (!isAdmin || adminLoading) return
    dispatchSelection({ type: "clear" })
    loadQueue(params, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, isAdmin, adminLoading])

  // "All matching" covers rows that are not loaded: fetch them (capped) so the bar and dialog see every one.
  useEffect(() => {
    if (!selection.allMatching) {
      setAllMatchingRows(null)
      return
    }
    let cancelled = false
    fetchQueue({ ...paramsRef.current, limit: SELECTION_CAP, offset: 0 })
      .then((r) => { if (!cancelled) setAllMatchingRows(r.data) })
      .catch((e) => {
        if (cancelled) return
        toast.error(e instanceof Error ? e.message : "Could not load the matching orders")
        dispatchSelection({ type: "clear" })
      })
    return () => { cancelled = true }
  }, [selection.allMatching])

  const selectedRows = useMemo(
    () => (selection.allMatching ? allMatchingRows ?? [] : rows.filter((r) => selection.ids.has(r.id))),
    [selection, allMatchingRows, rows],
  )
  const selectionSummary = useMemo(() => summarizeSelection(selectedRows), [selectedRows])
  const sendSuppliers = useMemo(() => suppliersForNetworks(selectionSummary.networks), [selectionSummary.networks])
  const anySelected = selection.allMatching || selection.ids.size > 0

  // Supplier balances for the Send menu: fetched once, the first time anything is selected (the route calls every supplier).
  useEffect(() => {
    if (!anySelected || balancesRequested.current) return
    balancesRequested.current = true
    ;(async () => {
      try {
        const res = await fetch("/api/admin/fulfillment/mtn-balance", { headers: await authHeaders() })
        if (!res.ok) return
        setBalances(parseSupplierBalances(await res.json().catch(() => null)))
      } catch { /* balances are optional */ }
    })()
  }, [anySelected])

  // Poll fulfillment queue progress while a batch is active
  useEffect(() => {
    if (!activeBatchId) return
    const poll = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session?.access_token) return
        const res = await fetch(`/api/admin/fulfillment/queue-status?batchId=${activeBatchId}`, {
          headers: { Authorization: `Bearer ${session.access_token}` }
        })
        if (!res.ok) return
        const data = await res.json()
        setBatchProgress(data)
        if (data.pending === 0 && data.processing === 0) {
          setActiveBatchId(null)
          loadPendingMTNOrders()
          reloadQueue()
          if (data.failed > 0 && data.completed === 0) {
            toast.error(`All ${data.failed} orders failed`)
          } else if (data.failed > 0) {
            toast.warning(`${data.completed} fulfilled, ${data.failed} failed`)
          } else {
            toast.success(`All ${data.completed} orders fulfilled`)
          }
        }
      } catch { /* ignore poll errors */ }
    }
    poll()
    const interval = setInterval(poll, 3000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBatchId])

  // Fetch global count for bulk operations when filters change
  useEffect(() => {
    if (showBulkUpdate && bulkDate) {
      fetchGlobalBulkCount()
    } else {
      setGlobalBulkCount(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch(`/api/admin/orders/all?${params.toString()}`, {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}
      })
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
        // The endpoint returns 'enabled' field, not 'setting'
        const isEnabled = data.enabled === true || data.enabled === "true"
        setAutoFulfillmentEnabled(isEnabled)
      } else {
        console.error("[PAYMENT-STATUS] Failed to load auto-fulfillment setting:", response.status)
      }
    } catch (error) {
      console.error("[PAYMENT-STATUS] Error loading auto-fulfillment setting:", error)
    }
  }

  const loadPendingMTNOrders = async () => {
    try {
      setLoadingMTNOrders(true)
      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch("/api/admin/fulfillment/manual-fulfill", {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      })
      if (response.ok) {
        const data = await response.json()
        setPendingMTNOrders(data.orders || [])
      }
    } catch (error) {
      console.error("Error loading pending MTN orders:", error)
    } finally {
      setLoadingMTNOrders(false)
    }
  }

  const handleBulkManualFulfill = async () => {
    if (pendingMTNOrders.length === 0) {
      toast.error("No pending MTN orders to fulfill")
      return
    }

    const eligible = pendingMTNOrders.filter(o => !skipIds.has(o.id))
    // The enqueue route takes at most 200 orders per request; press again for the next 200.
    const orders = eligible.slice(0, 200).map(o => ({ id: o.id, type: o.type || "shop" }))

    if (orders.length === 0) {
      toast.info("All pending orders were already tried this session. Reload to retry them.")
      return
    }

    try {
      setLoadingMTNOrders(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Session expired. Please refresh.")
        return
      }

      const response = await fetch("/api/admin/fulfillment/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
        body: JSON.stringify({ orders })
      })

      if (!response.ok) {
        const err = await response.json()
        throw new Error(err.error || "Enqueue failed")
      }

      const { batchId, queued, rejected } = await response.json()
      // The server re-checks every order; `queued` is the list it accepted, `rejected` the rest with reasons.
      const queuedCount = Array.isArray(queued) ? queued.length : Number(queued) || 0
      const rejectedCount = Array.isArray(rejected) ? rejected.length : 0
      setSkipIds(prev => new Set([...prev, ...orders.map(o => o.id)]))
      setActiveBatchId(batchId)
      setBatchProgress({ total: queuedCount, pending: queuedCount, processing: 0, completed: 0, failed: 0 })
      toast.success(
        `${queuedCount} orders queued — processing in the background` +
          (rejectedCount > 0 ? ` (${rejectedCount} skipped by the server check)` : "")
      )
    } catch (error) {
      console.error("Enqueue error:", error)
      toast.error(error instanceof Error ? error.message : "Failed to queue orders")
    } finally {
      setLoadingMTNOrders(false)
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
      setRows(prev => prev.map(order =>
        order.id === orderId ? { ...order, status: newStatus } : order
      ))
    } catch (error) {
      console.error("Error updating order status:", error)
      toast.error(error instanceof Error ? error.message : "Failed to update status")
    } finally {
      setUpdatingOrderId(null)
    }
  }

  const startFulfillWithProgress = async (order: QueueRow, provider: string) => {
    const phone = order.phoneNumber || ""
    const orderType = order.type || ""
    setFulfillProgress({
      open: true, orderId: order.id, orderType, phone, provider, done: false,
      steps: [{ label: `Dispatching via ${provider}`, status: "running" }],
    })
    const { data: { session } } = await supabase.auth.getSession()
    const headers = { "Content-Type": "application/json", ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) }

    // Admin explicitly selected a provider — dispatch directly without whitelist
    // pre-screening. The whitelist check was designed for auto-selection and would
    // override the admin's choice if the selected provider isn't in the registry.
    try {
      const dRes = await fetch("/api/admin/fulfillment/manual-fulfill", {
        method: "POST", headers,
        body: JSON.stringify({ shop_order_id: order.id, order_type: orderType, provider }),
      })
      const dData = await dRes.json()
      setFulfillProgress(prev => ({
        ...prev, done: true,
        steps: [{ label: `Dispatching via ${provider}`, status: dData.success ? "done" : "error", detail: dData.message || dData.error }],
      }))
      if (dData.success) {
        setRows(prev => prev.map(o => o.id === order.id ? { ...o, status: "processing" } : o))
        toast.success("Fulfillment triggered successfully")
      }
    } catch {
      setFulfillProgress(prev => ({
        ...prev, done: true,
        steps: [{ label: `Dispatching via ${provider}`, status: "error", detail: "Request failed" }],
      }))
    }
    setFulfillingOrderId(null)
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
      reloadQueue()
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
      reloadQueue()
    } catch (error) {
      console.error("[PAYMENT-STATUS] Bulk download error:", error)
      toast.error(error instanceof Error ? error.message : "Failed to download orders")
    } finally {
      setBulkDownloading(false)
    }
  }

  const handleBulkDownloadFailed = async () => {
    if (!bulkDate) {
      toast.error("Please select a date")
      return
    }

    try {
      setBulkDownloadingFailed(true)

      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("You must be logged in to perform this action")
        return
      }

      const payload = {
        orderType: "all",
        isRedownload: true,
        filters: {
          date: bulkDate,
          startTime: bulkStartTime,
          endTime: bulkEndTime,
          network: bulkNetwork,
          failureMode: "failed"
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
        const errorData = await response.json()
        throw new Error(errorData.error || "Failed to download failed orders")
      }

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      a.download = `orders-failed-${bulkNetwork || 'all'}-${bulkDate}-${timestamp}.xlsx`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)

      toast.success("Failed orders downloaded successfully")
    } catch (error) {
      console.error("[PAYMENT-STATUS] Failed orders download error:", error)
      toast.error(error instanceof Error ? error.message : "Failed to download failed orders")
    } finally {
      setBulkDownloadingFailed(false)
    }
  }

  // Read-only export of the selected rows, built in the browser. It deliberately does NOT use
  // /api/admin/orders/download, which claims orders and sends notifications.
  const handleExportSelected = async () => {
    try {
      setExporting(true)
      let chosen: QueueRow[]
      if (selection.allMatching) {
        chosen = (await fetchQueue({ ...params, limit: SELECTION_CAP, offset: 0 })).data
      } else {
        chosen = rows.filter((r) => selection.ids.has(r.id))
      }
      if (chosen.length === 0) {
        toast.error("No orders selected")
        return
      }
      const XLSX = await import("xlsx")
      const sheet = XLSX.utils.json_to_sheet(queueRowsToSheetRows(chosen), { header: [...EXPORT_COLUMNS] })
      const book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(book, sheet, "Orders")
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
      XLSX.writeFile(book, `order-queue-${params.view}-${timestamp}.xlsx`)
      toast.success(`Exported ${chosen.length} order${chosen.length === 1 ? "" : "s"}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Export failed")
    } finally {
      setExporting(false)
    }
  }

  const openSendDialog = (supplier: SupplierOption) => {
    setAckTyped("")
    setAckChecked(false)
    setSendError(null)
    setSendSummary(selectionSummary)
    setSendSupplier(supplier)
  }

  // Send the selected orders to ONE supplier (hard pin). The server re-judges every order; the preview
  // only decides what is offered. Preview-blocked rows are not sent and are listed in the results.
  const handleSendSelected = async () => {
    const supplier = sendSupplier
    const summary = sendSummary
    if (!supplier || !summary || sending) return
    const toSend = [...summary.sendable, ...summary.risky]
    if (toSend.length === 0) return
    try {
      setSending(true)
      setSendError(null)
      const headers = await authHeaders()
      if (!headers.Authorization) {
        setSendError("Session expired. Please refresh.")
        return
      }
      // Risky orders are acknowledged with the typed count AND the ids shown in the dialog.
      const body = buildSendBody(summary, supplier.value, ackTyped)
      const res = await fetch("/api/admin/fulfillment/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 400 && data?.error === "risky_ack_mismatch") {
        setSendError(ACK_MISMATCH_COPY)
        return
      }
      if (!res.ok) {
        setSendError(typeof data?.error === "string" ? data.error : "Send failed")
        return
      }
      const queued: string[] = Array.isArray(data.queued) ? data.queued : []
      const rejected: { id: string; reason: string }[] = Array.isArray(data.rejected) ? data.rejected : []
      setSendResult({
        supplierLabel: supplier.label,
        queued,
        rejected: [...rejected, ...summary.blocked.map((b) => ({ id: b.row.id, reason: b.reason }))],
        risky: Array.isArray(data.risky) ? data.risky : [],
      })
      if (queued.length > 0 && typeof data.batchId === "string") {
        setActiveBatchId(data.batchId)
        setBatchProgress({ total: queued.length, pending: queued.length, processing: 0, completed: 0, failed: 0 })
      }
      setSendSupplier(null)
      toast.success(`${queued.length} queued to ${supplier.label}${rejected.length > 0 ? ` · ${rejected.length} rejected` : ""}`)
      reloadQueue()
    } catch {
      setSendError("Send failed — check the queue before trying again.")
    } finally {
      setSending(false)
    }
  }

  // "Change status" from the bar: the same bulk-update-status route as the row menu, for the selected ids.
  const handleBarStatusChange = async (status: string) => {
    const ids = selectedRows.map((r) => r.id)
    if (ids.length === 0) return
    if (!window.confirm(`Change ${ids.length} order${ids.length === 1 ? "" : "s"} to "${status}"?`)) return
    try {
      setBarStatusUpdating(true)
      const headers = await authHeaders()
      const res = await fetch("/api/admin/orders/bulk-update-status", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ orderIds: ids, status }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || "Failed to update orders")
      toast.success(`Updated ${data?.count ?? ids.length} orders to ${status}`)
      reloadQueue()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update orders")
    } finally {
      setBarStatusUpdating(false)
    }
  }

  const renderRowActions = (order: QueueRow) => (
    <div className="flex min-w-[8.5rem] flex-col gap-2">
      <select
        className="px-2 py-1 text-xs border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 border-white/60 dark:border-white/5 clay-inset"
        onChange={(e) => handleStatusUpdate(order.id, order.type || "", e.target.value)}
        disabled={!order.type || updatingOrderId === order.id}
        defaultValue=""
        aria-label="Update order status"
        title={order.type ? undefined : "Order type unknown — open it in Orders"}
      >
        <option value="">{updatingOrderId === order.id ? "Updating..." : "Update Status"}</option>
        <option value="pending">Pending</option>
        <option value="processing">Processing</option>
        <option value="completed">Completed</option>
        <option value="failed">Failed</option>
      </select>
      {order.type && order.status === "pending" && order.paymentStatus === "completed" && (
        fulfillingOrderId === order.id ? (
          <Button size="sm" variant="outline" className="text-xs h-7 gap-1" disabled>
            <Loader2 className="w-3 h-3 animate-spin" />
            Fulfilling...
          </Button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="text-xs h-7 gap-1">
                <Send className="w-3 h-3" />
                Fulfill
                <ChevronDown className="w-3 h-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel className="text-xs text-muted-foreground">Select Provider</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {getProviderOptionsForNetwork(order.network || "").map(p => (
                <DropdownMenuItem
                  key={p.value}
                  className="cursor-pointer"
                  onClick={() => startFulfillWithProgress(order, p.value)}
                >
                  {p.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )
      )}
    </div>
  )

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

  const activeFilterCount =
    params.statuses.length + params.networks.length + params.types.length +
    (params.from ? 1 : 0) + (params.to ? 1 : 0) + (params.search ? 1 : 0) +
    (params.lastProvider ? 1 : 0) + (params.failureReason ? 1 : 0)
  const selectedCount = selection.allMatching ? total : selection.ids.size
  const allLoadedSelected = rows.length > 0 && rows.every((r) => selection.ids.has(r.id))
  const offerAllMatching = !selection.allMatching && allLoadedSelected && total > rows.length

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <PageHeaderBanner
            className="flex-1"
            title="Order Work Queue"
            subtitle="Find the orders that need you, see what the last supplier said, and act on them"
          />
          {autoFulfillmentEnabled && pendingMTNOrders.length > 0 && (
            <Button
              onClick={handleBulkManualFulfill}
              disabled={loadingMTNOrders}
              className="bg-destructive hover:bg-destructive/90 text-primary-foreground font-bold shadow-lg transform transition hover:scale-105"
            >
              {loadingMTNOrders ? (
                <Loader2 className="h-5 w-5 mr-2 animate-spin" />
              ) : (
                <Zap className="h-5 w-5 mr-2" />
              )}
              {(() => {
                const eligible = pendingMTNOrders.filter(o => !skipIds.has(o.id))
                const batch = Math.min(eligible.length, 1000)
                const total = pendingMTNOrders.length
                const skipped = total - eligible.length
                if (eligible.length === 0) return `Fulfill Pending MTN (all ${total} tried this session)`
                return `Fulfill Pending MTN (${batch}${eligible.length > 1000 ? ` of ${eligible.length}` : ""}${skipped > 0 ? `, ${skipped} skipped` : ""})`
              })()}
            </Button>
          )}
        </div>

        <AutoFulfilPanel />

        {sendResult && <SendResults result={sendResult} onDismiss={() => setSendResult(null)} />}

        {/* Fulfillment queue progress */}
        {batchProgress && (
          <Card className="border-yellow-500/30 bg-yellow-500/5">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">
                  {activeBatchId ? "Processing fulfillment queue…" : "Last batch complete"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {batchProgress.completed} done · {batchProgress.failed} failed · {batchProgress.pending + batchProgress.processing} remaining
                </span>
              </div>
              <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-500"
                  style={{ width: `${batchProgress.total > 0 ? ((batchProgress.completed + batchProgress.failed) / batchProgress.total) * 100 : 0}%` }}
                />
              </div>
            </CardContent>
          </Card>
        )}

        <QueueTabs view={params.view} counts={counts} onChange={(view) => setParams({ ...params, view })} />

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
          {/* Filters: left column on desktop, collapsible above the table on mobile */}
          <aside className="space-y-3">
            <Button
              type="button"
              variant="outline"
              className="w-full justify-between lg:hidden"
              aria-expanded={showFilters}
              onClick={() => setShowFilters((s) => !s)}
            >
              <span className="flex items-center gap-2">
                <SlidersHorizontal className="h-4 w-4" />
                Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
              </span>
              <ChevronDown className={cn("h-4 w-4 transition-transform", showFilters && "rotate-180")} />
            </Button>
            <Card className={cn(showFilters ? "block" : "hidden", "lg:sticky lg:top-4 lg:block")}>
              <CardContent className="pt-6">
                <FilterPanel
                  params={params}
                  onChange={setParams}
                  onReset={() => setParams({ ...defaultParams(), view: params.view })}
                />
              </CardContent>
            </Card>
          </aside>

          <Card className="min-w-0">
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
              <div>
                <CardTitle>Orders</CardTitle>
                <CardDescription>
                  {loadingQueue && rows.length === 0
                    ? "Loading…"
                    : `Showing ${rows.length} of ${total} order${total !== 1 ? "s" : ""}`}
                  {selectedCount > 0 && (
                    <span className="ml-2 font-medium text-primary">· {selectedCount} selected</span>
                  )}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                {selectedCount > 0 && (
                  <Button variant="ghost" size="sm" onClick={() => dispatchSelection({ type: "clear" })}>
                    Clear selection
                  </Button>
                )}
                <ActionsMenu
                  selectedCount={selectedCount}
                  exporting={exporting}
                  onExportSelected={handleExportSelected}
                  onOpenBulkTool={() => setShowBulkUpdate(true)}
                />
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {(offerAllMatching || selection.allMatching || selection.error === "cap") && (
                <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm">
                  {selection.allMatching ? (
                    <>All {total} matching orders are selected.</>
                  ) : selection.error === "cap" ? (
                    <span className="text-destructive">
                      That is {total} orders — narrow the filters to {SELECTION_CAP} or fewer to select them all.
                    </span>
                  ) : (
                    <>
                      All {rows.length} loaded orders are selected.{" "}
                      <button
                        type="button"
                        className="font-semibold text-primary underline-offset-2 hover:underline"
                        onClick={() => dispatchSelection({ type: "selectAllMatching", total })}
                      >
                        Select all {total} matching
                      </button>
                    </>
                  )}
                </div>
              )}

              {loadingQueue && rows.length === 0 ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : loadError && rows.length === 0 ? (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="flex flex-wrap items-center gap-2">
                    {loadError}
                    <Button size="sm" variant="outline" onClick={reloadQueue}>Try again</Button>
                  </AlertDescription>
                </Alert>
              ) : rows.length === 0 ? (
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    {activeFilterCount > 0 ? "No orders match these filters" : "Nothing in this view"}
                  </AlertDescription>
                </Alert>
              ) : (
                <QueueTable
                  rows={rows}
                  selectedIds={selection.ids}
                  allMatching={selection.allMatching}
                  onToggle={(id) => dispatchSelection({ type: "toggle", id })}
                  onTogglePage={(select) =>
                    dispatchSelection(select ? { type: "selectPage", ids: rows.map((r) => r.id) } : { type: "clear" })
                  }
                  renderActions={renderRowActions}
                />
              )}

              {hasMore && rows.length > 0 && (
                <div className="flex justify-center pb-4">
                  <Button
                    variant="outline"
                    onClick={() => loadQueue(params, true)}
                    disabled={loadingQueue}
                    className="w-full max-w-xs border-primary/20 hover:bg-primary/5 text-primary font-semibold"
                  >
                    {loadingQueue ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Loading more...
                      </>
                    ) : (
                      "Load more orders"
                    )}
                  </Button>
                </div>
              )}

              {!hasMore && rows.length > 0 && (
                <p className="text-center text-muted-foreground text-xs pb-4">No more orders to display</p>
              )}
            </CardContent>
          </Card>
        </div>

        <BulkActionBar
          selectedCount={selectedCount}
          totalGb={selection.allMatching && allMatchingRows === null ? null : selectionSummary.totalGb}
          suppliers={sendSuppliers}
          balances={balances}
          busy={sending || barStatusUpdating || (selection.allMatching && allMatchingRows === null)}
          exporting={exporting}
          onSend={openSendDialog}
          onChangeStatus={handleBarStatusChange}
          onExport={handleExportSelected}
          onClear={() => dispatchSelection({ type: "clear" })}
        />
      </div>

      <SendConfirmDialog
        supplier={sendSupplier}
        onOpenChange={(open) => { if (!open) setSendSupplier(null) }}
        summary={sendSummary ?? selectionSummary}
        balance={sendSupplier ? balances[sendSupplier.value] : undefined}
        typedCount={ackTyped}
        onTypedCountChange={setAckTyped}
        checked={ackChecked}
        onCheckedChange={setAckChecked}
        sending={sending}
        error={sendError}
        onSend={handleSendSelected}
        onCancel={() => setSendSupplier(null)}
      />

      <BulkToolDialog
        open={showBulkUpdate}
        onOpenChange={setShowBulkUpdate}
        bulkDate={bulkDate}
        setBulkDate={setBulkDate}
        bulkStartTime={bulkStartTime}
        setBulkStartTime={setBulkStartTime}
        bulkEndTime={bulkEndTime}
        setBulkEndTime={setBulkEndTime}
        bulkNetwork={bulkNetwork}
        setBulkNetwork={setBulkNetwork}
        bulkStatus={bulkStatus}
        setBulkStatus={setBulkStatus}
        bulkUpdating={bulkUpdating}
        bulkDownloading={bulkDownloading}
        bulkDownloadingFailed={bulkDownloadingFailed}
        globalBulkCount={loadingBulkCount ? null : globalBulkCount}
        onBulkStatusUpdate={handleBulkStatusUpdate}
        onBulkDownload={handleBulkDownload}
        onBulkDownloadFailed={handleBulkDownloadFailed}
      />

      {/* Fulfill progress dialog */}
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
                    step.status === "done"    ? "text-success"          :
                    step.status === "error"   ? "text-destructive"      :
                    step.status === "running" ? "text-foreground"       :
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
    </DashboardLayout>
  )
}
