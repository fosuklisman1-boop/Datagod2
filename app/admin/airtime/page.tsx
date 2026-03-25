"use client"

import { useState, useEffect, useCallback } from "react"
import { createClient } from "@supabase/supabase-js"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Download, CheckCircle, Clock, AlertCircle, Check, Loader2, Search, RefreshCw, Copy, ExternalLink } from "lucide-react"
import { toast } from "sonner"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

interface AirtimeOrder {
  id: string
  reference_code: string
  network: string
  beneficiary_phone: string
  airtime_amount: number
  fee_amount: number
  total_paid: number
  status: string
  notes: string | null
  created_at: string
  users?: { email: string }
  user_shops?: { shop_name: string }
  customer_name: string | null
  customer_email: string | null
  merchant_commission: number
}

interface DownloadBatch {
  id: string
  network: string
  batch_time: string
  orders: AirtimeOrder[]
  order_count: number
  downloaded_by_email?: string
}

interface Stats {
  totalRevenue: number
  totalProfit: number
  totalMerchantPayout: number
  totalVolume: number
  pending: number
  processing: number
  completed: number
  failed: number
}

const STATUS_CLASSES: Record<string, string> = {
  pending:    "bg-yellow-100 text-yellow-800",
  processing: "bg-blue-100 text-blue-800",
  completed:  "bg-green-100 text-green-800",
  failed:     "bg-red-100 text-red-800",
}

export default function AdminAirtimePage() {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<"pending" | "downloaded">("pending")
  const [orders, setOrders]       = useState<AirtimeOrder[]>([])
  const [batches, setBatches]     = useState<DownloadBatch[]>([])
  const [stats, setStats]         = useState<Stats | null>(null)
  const [loading, setLoading]     = useState(true)
  const [loadingBatches, setLoadingBatches] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [token, setToken]         = useState<string | null>(null)

  // Filters
  const [date, setDate]           = useState("")
  const [network, setNetwork]     = useState("all")
  const [status, setStatus]       = useState("pending")
  const [search, setSearch]       = useState("")
  const [downloadedBatchFilter, setDownloadedBatchFilter] = useState("all")
  const [downloadedBatchStatusFilter, setDownloadedBatchStatusFilter] = useState("all")
  const [downloadedNetworkFilter, setDownloadedNetworkFilter] = useState("all")

  // Action modal
  const [actionModal, setActionModal] = useState<{ order: AirtimeOrder; action: "completed" | "failed" } | null>(null)
  const [notes, setNotes]         = useState("")
  const [actioning, setActioning] = useState(false)
  const [actionMsg, setActionMsg] = useState("")

  // Copy feedback
  const [copiedId, setCopiedId]   = useState<string | null>(null)

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    toast.success("Copied to clipboard")
    setTimeout(() => setCopiedId(null), 1500)
  }

  const getToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push("/auth/login"); return null }
    setToken(session.access_token)
    return session.access_token
  }, [router])

  const loadOrders = useCallback(async (tok?: string) => {
    const t = tok || token
    if (!t) return
    setLoading(true)
    const params = new URLSearchParams({ date, network, status })
    if (search) params.set("search", search)
    const res = await fetch(`/api/admin/airtime/list?${params}`, {
      headers: { Authorization: `Bearer ${t}` },
    })
    if (res.status === 403) { router.push("/dashboard"); return }
    const data = await res.json()
    if (!res.ok) {
      console.error("[ADMIN-AIRTIME] Fetch error:", data.error)
      setOrders([])
      setStats(null)
    } else {
      setOrders(data.orders || [])
      setStats(data.stats || null)
    }
    setLoading(false)
  }, [token, date, network, status, search, router])

  const loadBatches = useCallback(async (tok?: string) => {
    const t = tok || token
    if (!t) return
    setLoadingBatches(true)
    try {
      const res = await fetch("/api/admin/airtime/batches", {
        headers: { Authorization: `Bearer ${t}` },
      })
      const data = await res.json()
      if (res.ok) {
        setBatches(data.data || [])
      }
    } catch (error) {
      console.error("[ADMIN-AIRTIME] Batch load error:", error)
    } finally {
      setLoadingBatches(false)
    }
  }, [token])

  useEffect(() => {
    getToken().then(t => { 
      if (t) {
        loadOrders(t)
        loadBatches(t)
      }
    })
  }, [getToken])

  useEffect(() => {
    if (token) loadOrders()
  }, [date, network, status, token, loadOrders])

  const handleSearch = (e: React.FormEvent) => { e.preventDefault(); loadOrders() }

  const handleDownload = async () => {
    if (downloading) return
    setDownloading(true)
    try {
      const t = token || await getToken()
      if (!t) return

      const response = await fetch("/api/admin/airtime/download", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          Authorization: `Bearer ${t}` 
        },
        body: JSON.stringify({ orderIds: [] }) // Download all pending if empty
      })

      if (!response.ok) throw new Error("Download failed")

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `airtime-orders-${new Date().toISOString().split('T')[0]}.xlsx`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      
      toast.success("Download started. Statuses updated to processing.")
      loadOrders()
      loadBatches()
    } catch (error) {
      toast.error("Failed to download orders")
    } finally {
      setDownloading(false)
    }
  }

  const handleBulkStatusUpdate = async (batchOrders: AirtimeOrder[], newStatus: "completed" | "failed") => {
    if (!confirm(`Are you sure you want to mark ${batchOrders.length} orders as ${newStatus}?`)) return
    
    try {
      const t = token || await getToken()
      if (!t) return

      const res = await fetch("/api/admin/airtime/bulk-update-status", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          Authorization: `Bearer ${t}` 
        },
        body: JSON.stringify({ 
          orderIds: batchOrders.map(o => o.id),
          status: newStatus
        })
      })

      const result = await res.json()
      if (res.ok) {
        toast.success(result.message)
        loadOrders()
        loadBatches()
      } else {
        throw new Error(result.error)
      }
    } catch (error: any) {
      toast.error(error.message || "Bulk update failed")
    }
  }

  const handleAction = async () => {
    if (!actionModal || !token) return
    setActioning(true)
    setActionMsg("")
    const res = await fetch("/api/admin/airtime/action", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ orderId: actionModal.order.id, action: actionModal.action, notes }),
    })
    const data = await res.json()
    setActioning(false)
    if (res.ok) {
      setActionModal(null)
      setNotes("")
      toast.success(`Order ${actionModal.action} successfully`)
      loadOrders()
    } else {
      setActionMsg(data.error || "Action failed")
    }
  }

  const statCards = stats
    ? [
        { label: "Revenue",   value: `GHS ${Number(stats.totalRevenue || 0).toFixed(2)}`,  color: "text-indigo-600" },
        { label: "Net Profit", value: `GHS ${Number(stats.totalProfit || 0).toFixed(2)}`,   color: "text-green-600" },
        { label: "Merchant Payout", value: `GHS ${Number(stats.totalMerchantPayout || 0).toFixed(2)}`, color: "text-orange-600" },
        { label: "Volume",    value: `GHS ${Number(stats.totalVolume || 0).toFixed(2)}`,   color: "text-blue-600" },
        { label: "Pending",   value: stats.pending,                            color: "text-yellow-600" },
        { label: "Completed", value: stats.completed,                          color: "text-emerald-600" },
      ]
    : []

  const getFilteredBatches = () => {
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
    const monthAgo = new Date(today.getFullYear(), today.getMonth() - 1, today.getDate())

    return batches.filter((batch) => {
      const batchDate = new Date(batch.batch_time)
      const batchDateOnly = new Date(batchDate.getFullYear(), batchDate.getMonth(), batchDate.getDate())

      // Network filter
      if (downloadedNetworkFilter !== "all" && batch.network !== downloadedNetworkFilter) return false

      // Date filter
      if (downloadedBatchFilter !== "all") {
        if (downloadedBatchFilter === "today" && batchDateOnly.getTime() !== today.getTime()) return false
        if (downloadedBatchFilter === "yesterday" && batchDateOnly.getTime() !== yesterday.getTime()) return false
        if (downloadedBatchFilter === "this-week" && batchDate < weekAgo) return false
        if (downloadedBatchFilter === "this-month" && batchDate < monthAgo) return false
      }

      // Status filter
      if (downloadedBatchStatusFilter !== "all") {
        const statuses = batch.orders.map(o => o.status)
        if (downloadedBatchStatusFilter === "completed" && !statuses.every(s => s === "completed")) return false
        if (downloadedBatchStatusFilter === "failed" && !statuses.some(s => s === "failed")) return false
        if (downloadedBatchStatusFilter === "processing" && !statuses.some(s => s === "processing" || s === "pending")) return false
      }

      return true
    })
  }

  const filteredBatches = getFilteredBatches()

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold bg-gradient-to-r from-red-600 via-purple-600 to-pink-600 bg-clip-text text-transparent">
              Airtime Management
            </h1>
            <p className="text-gray-500 mt-1 font-medium text-sm">Download and manage pending airtime orders</p>
          </div>
          <Button onClick={() => loadOrders()} variant="outline" size="sm" className="w-fit">
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh Data
          </Button>
        </div>

        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {statCards.map((s) => (
              <div key={s.label} className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 text-center">
                <p className="text-xs text-gray-400 uppercase tracking-wide">{s.label}</p>
                <p className={`text-lg font-bold mt-1 ${s.color}`}>{s.value}</p>
              </div>
            ))}
          </div>
        )}

        <Tabs value={activeTab} onValueChange={(v: any) => setActiveTab(v)} className="w-full">
          <TabsList className="grid w-full grid-cols-2 h-auto">
            <TabsTrigger 
              value="pending" 
              className="flex items-center justify-center gap-1 px-2 py-2 text-xs sm:text-sm"
              onClick={() => { if(status === 'all') setStatus('pending') }}
            >
              <Clock className="h-3 w-3 sm:h-4 sm:w-4 shrink-0" />
              <span>Pending Orders</span>
              {stats && (stats.pending > 0 || stats.processing > 0) && (
                <Badge variant="secondary" className="ml-1 bg-yellow-100 text-yellow-700 text-[10px] px-1.5 h-4">
                  {stats.pending + stats.processing}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger 
              value="downloaded" 
              className="flex items-center justify-center gap-1 px-2 py-2 text-xs sm:text-sm"
              onClick={() => setStatus('all')}
            >
              <CheckCircle className="h-3 w-3 sm:h-4 sm:w-4 shrink-0" />
              <span>Download Batches</span>
              <Badge variant="secondary" className="ml-1 bg-indigo-100 text-indigo-700 text-[10px] px-1.5 h-4">
                {batches.length}
              </Badge>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="pending" className="space-y-6 pt-4">
            {/* Filters */}
            <div className="flex justify-between items-center gap-4">
              <form onSubmit={handleSearch} className="flex-1 bg-white rounded-xl border border-gray-100 shadow-sm p-4 flex flex-wrap gap-3 items-end">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Date</label>
                  <input type="date" value={date} onChange={e => setDate(e.target.value)}
                    className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Network</label>
                  <select value={network} onChange={e => setNetwork(e.target.value)}
                    className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                    <option value="all">All</option>
                    <option>MTN</option><option>Telecel</option><option>AT</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
                  <select value={status} onChange={e => setStatus(e.target.value)}
                    className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                    <option value="all">All</option>
                    <option>pending</option><option>processing</option><option>completed</option><option>failed</option>
                  </select>
                </div>
                <div className="flex-1 min-w-[180px]">
                  <label className="block text-xs font-medium text-gray-500 mb-1">Search</label>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                      placeholder="Reference or Phone…"
                      className="w-full border border-gray-200 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </div>
                </div>
                <Button type="submit" variant="default" className="bg-indigo-600 hover:bg-indigo-700">
                  Search
                </Button>
              </form>
              
              <Button 
                onClick={handleDownload} 
                disabled={downloading || orders.filter(o => o.status === 'pending').length === 0} 
                className="bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white font-semibold h-[58px] px-6"
              >
                {downloading ? (
                  <Loader2 className="w-5 h-5 animate-spin mr-2" />
                ) : (
                  <Download className="w-5 h-5 mr-2" />
                )}
                Download All ({orders.filter(o => o.status === 'pending').length})
              </Button>
            </div>

            {/* Orders Table */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-100">
                    <tr>
                      {["Reference","Customer","Shop","Network","Phone","Airtime","Total","Status","Date","Actions"].map(h => (
                        <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {loading ? (
                      <tr><td colSpan={10} className="text-center py-12 text-gray-400">Loading orders...</td></tr>
                    ) : orders.length === 0 ? (
                      <tr><td colSpan={10} className="text-center py-12 text-gray-400">No pending orders found.</td></tr>
                    ) : (
                      orders.map((o) => (
                        <tr key={o.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-3 font-mono text-xs font-semibold text-gray-800">{o.reference_code}</td>
                          <td className="px-4 py-3">
                            <p className="text-xs font-medium text-gray-900 truncate max-w-[120px]" title={o.users?.email || o.customer_email || "Guest"}>
                              {o.users?.email || o.customer_email || o.customer_name || "Guest"}
                            </p>
                          </td>
                          <td className="px-4 py-3">
                            <p className="text-xs text-gray-600 italic">
                              {o.user_shops?.shop_name || "Direct"}
                            </p>
                          </td>
                          <td className="px-4 py-3">
                             <Badge variant="outline" className={o.network === 'MTN' ? 'border-yellow-200 bg-yellow-50 text-yellow-700' : o.network === 'Telecel' ? 'border-red-200 bg-red-50 text-red-700' : 'border-blue-200 bg-blue-50 text-blue-700'}>
                                {o.network}
                             </Badge>
                          </td>
                          <td className="px-4 py-3">
                            <button
                              onClick={() => copyToClipboard(o.beneficiary_phone, o.id)}
                              className="font-mono text-xs bg-gray-100 hover:bg-indigo-100 text-gray-800 px-2 py-1 rounded transition-colors inline-flex items-center gap-1"
                            >
                              {copiedId === o.id ? "✓" : <Copy className="w-3 h-3" />}
                              {o.beneficiary_phone}
                            </button>
                          </td>
                          <td className="px-4 py-3 font-semibold text-gray-900">GHS {Number(o.airtime_amount || 0).toFixed(2)}</td>
                          <td className="px-4 py-3 font-bold text-indigo-700">GHS {Number(o.total_paid || 0).toFixed(2)}</td>
                          <td className="px-4 py-3">
                            <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-full ${STATUS_CLASSES[o.status || 'pending'] || "bg-gray-100 text-gray-600"}`}>
                              {(o.status || 'pending').toUpperCase()}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">
                            {new Date(o.created_at).toLocaleString()}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-[10px] bg-green-50 text-green-700 hover:bg-green-100 border-green-200"
                                onClick={() => { setActionModal({ order: o, action: "completed" }); setNotes(""); setActionMsg("") }}
                              >
                                Complete
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-[10px] bg-red-50 text-red-700 hover:bg-red-100 border-red-200"
                                onClick={() => { setActionModal({ order: o, action: "failed" }); setNotes(""); setActionMsg("") }}
                              >
                                Fail
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="downloaded" className="space-y-4 pt-4">
            {/* Batch Filters */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
               <Card>
                 <CardHeader className="py-3 px-4">
                   <CardTitle className="text-sm font-semibold">Filter by Status</CardTitle>
                 </CardHeader>
                 <CardContent className="p-3 pt-0 flex flex-wrap gap-2">
                    {["all", "completed", "processing", "failed"].map(s => (
                      <Button 
                        key={s} 
                        variant={downloadedBatchStatusFilter === s ? "default" : "outline"} 
                        size="sm" 
                        onClick={() => setDownloadedBatchStatusFilter(s)}
                        className="text-[10px] h-7 px-2"
                      >
                        {s.toUpperCase()}
                      </Button>
                    ))}
                 </CardContent>
               </Card>
               <Card>
                 <CardHeader className="py-3 px-4">
                   <CardTitle className="text-sm font-semibold">Filter by Network</CardTitle>
                 </CardHeader>
                 <CardContent className="p-3 pt-0 flex flex-wrap gap-2">
                    {["all", "MTN", "Telecel", "AT"].map(n => (
                      <Button 
                        key={n} 
                        variant={downloadedNetworkFilter === n ? "default" : "outline"} 
                        size="sm" 
                        onClick={() => setDownloadedNetworkFilter(n)}
                        className="text-[10px] h-7 px-2"
                      >
                        {n}
                      </Button>
                    ))}
                 </CardContent>
               </Card>
               <Card>
                 <CardHeader className="py-3 px-4">
                   <CardTitle className="text-sm font-semibold">Filter by Date</CardTitle>
                 </CardHeader>
                 <CardContent className="p-3 pt-0 flex flex-wrap gap-2">
                    {["all", "today", "yesterday", "this-week", "this-month"].map(d => (
                      <Button 
                        key={d} 
                        variant={downloadedBatchFilter === d ? "default" : "outline"} 
                        size="sm" 
                        onClick={() => setDownloadedBatchFilter(d)}
                        className="text-[10px] h-7 px-2"
                      >
                        {d.replace("-", " ").toUpperCase()}
                      </Button>
                    ))}
                 </CardContent>
               </Card>
            </div>

            {loadingBatches ? (
              <div className="text-center py-12 text-gray-400">Loading batches...</div>
            ) : filteredBatches.length === 0 ? (
              <div className="text-center py-12 text-gray-400 bg-white rounded-xl border border-dashed border-gray-200">
                No batches match your filters.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {filteredBatches.map((batch) => (
                  <Card key={batch.id} className="overflow-hidden border-gray-200 shadow-sm">
                    <CardHeader className="bg-gray-50/50 py-4">
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2">
                           <Badge className={batch.network === 'MTN' ? 'bg-yellow-500' : batch.network === 'Telecel' ? 'bg-red-600' : 'bg-blue-600'}>
                             {batch.network}
                           </Badge>
                           <span className="text-xs font-medium text-gray-500">
                             {new Date(batch.batch_time).toLocaleString()}
                           </span>
                        </div>
                        <Badge variant="outline" className="font-mono">
                          {batch.order_count} orders
                        </Badge>
                      </div>
                      <CardDescription className="text-[10px] mt-1">
                        Downloaded by: {batch.downloaded_by_email}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="py-4 space-y-4">
                      <div className="max-h-[200px] overflow-y-auto border rounded-lg">
                        <table className="w-full text-[10px]">
                          <thead className="bg-gray-50 sticky top-0">
                            <tr>
                              <th className="px-2 py-1 text-left">Ref</th>
                              <th className="px-2 py-1 text-left">Phone</th>
                              <th className="px-2 py-1 text-left">Amount</th>
                              <th className="px-2 py-1 text-left">Status</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-50">
                            {batch.orders.map((order) => (
                              <tr key={order.id}>
                                <td className="px-2 py-1 font-mono">{order.reference_code}</td>
                                <td className="px-2 py-1">{order.beneficiary_phone}</td>
                                <td className="px-2 py-1 font-bold">GHS {Number(order.airtime_amount).toFixed(2)}</td>
                                <td className="px-2 py-1">
                                  <span className={`text-[8px] font-bold px-1 rounded ${STATUS_CLASSES[order.status]}`}>
                                    {order.status.toUpperCase()}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                         <Button 
                           size="sm" 
                           variant="outline" 
                           className="text-[10px] h-8 border-green-200 text-green-700 hover:bg-green-50"
                           onClick={() => handleBulkStatusUpdate(batch.orders, "completed")}
                         >
                           <CheckCircle className="w-3 h-3 mr-1" /> Mark Batch Complete
                         </Button>
                         <Button 
                           size="sm" 
                           variant="outline" 
                           className="text-[10px] h-8 border-red-200 text-red-700 hover:bg-red-50"
                           onClick={() => handleBulkStatusUpdate(batch.orders, "failed")}
                         >
                           <AlertCircle className="w-3 h-3 mr-1" /> Mark Batch Failed
                         </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>

        {/* Single Action Modal */}
        {actionModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 animate-in fade-in duration-200">
            <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4 transform transition-all scale-100">
              <h3 className="text-lg font-bold text-gray-900">
                {actionModal.action === "completed" ? "✅ Mark as Completed" : "❌ Mark as Failed"}
              </h3>
              <div className="bg-gray-50 rounded-xl p-4 text-sm space-y-1">
                <p><span className="text-gray-500">Ref:</span> <strong>{actionModal.order.reference_code}</strong></p>
                <p><span className="text-gray-500">Network:</span> {actionModal.order.network}</p>
                <p><span className="text-gray-500">Phone:</span> {actionModal.order.beneficiary_phone}</p>
                <p><span className="text-gray-500">Airtime:</span> GHS {Number(actionModal.order.airtime_amount || 0).toFixed(2)}</p>
                {actionModal.action === "failed" && (
                  <p className="text-red-600 font-semibold mt-2">⚠ GHS {Number(actionModal.order.total_paid || 0).toFixed(2)} will be refunded to the user's wallet.</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Notes (optional)</label>
                <input
                  type="text"
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder={actionModal.action === "failed" ? "e.g. Network unreachable" : "e.g. Sent via portal"}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              {actionMsg && <p className="text-red-600 text-sm">{actionMsg}</p>}
              <div className="flex gap-3 justify-end items-center pt-2">
                <Button variant="ghost" onClick={() => setActionModal(null)} disabled={actioning}>
                  Cancel
                </Button>
                <Button
                  onClick={handleAction}
                  disabled={actioning}
                  className={actionModal.action === "completed" ? "bg-green-600 hover:bg-green-700" : "bg-red-600 hover:bg-red-700"}
                >
                  {actioning ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Confirm {actionModal.action === "completed" ? "Fulfillment" : "Failure"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
