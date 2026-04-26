"use client"

import { useState, useEffect, useCallback } from "react"
import { createClient } from "@supabase/supabase-js"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Upload, Download, Package, ShoppingCart, Settings, AlertCircle, CheckCircle,
  Clock, Loader2, Search, RefreshCw, XCircle, ChevronDown, ChevronUp,
} from "lucide-react"
import { toast } from "sonner"
import { useAdminProtected } from "@/hooks/use-admin"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const EXAM_BOARDS = ["WAEC", "BECE", "NOVDEC"]

const STATUS_CLASSES: Record<string, string> = {
  available:  "bg-green-100 text-green-700",
  reserved:   "bg-yellow-100 text-yellow-800",
  sold:       "bg-blue-100 text-blue-700",
  used:       "bg-gray-100 text-gray-600",
  expired:    "bg-orange-100 text-orange-700",
  invalid:    "bg-red-100 text-red-700",
  pending:         "bg-yellow-100 text-yellow-800",
  pending_payment: "bg-purple-100 text-purple-700",
  completed:       "bg-green-100 text-green-700",
  failed:          "bg-red-100 text-red-700",
}

interface InventorySummary {
  waec:   { available: number; reserved: number; sold: number; invalid: number; expired: number }
  bece:   { available: number; reserved: number; sold: number; invalid: number; expired: number }
  novdec: { available: number; reserved: number; sold: number; invalid: number; expired: number }
}

interface RCOrder {
  id: string
  reference_code: string
  exam_board: string
  quantity: number
  unit_price: number
  total_paid: number
  merchant_commission: number
  status: string
  payment_status: string
  customer_name: string | null
  customer_email: string | null
  created_at: string
  users?: { email: string; first_name: string; last_name: string }
  user_shops?: { shop_name: string }
}

interface ParseError { row: number; reason: string; raw: string }

export default function AdminResultsCheckerPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [activeTab, setActiveTab] = useState<"inventory" | "upload" | "orders" | "settings">("inventory")
  const [token, setToken] = useState<string | null>(null)

  // Inventory state
  const [inventoryItems, setInventoryItems] = useState<any[]>([])
  const [summary, setSummary] = useState<InventorySummary | null>(null)
  const [inventoryLoading, setInventoryLoading] = useState(true)
  const [inventoryTotal, setInventoryTotal] = useState(0)
  const [invBoardFilter, setInvBoardFilter] = useState("all")
  const [invStatusFilter, setInvStatusFilter] = useState("available")
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Upload state
  const [uploadBoard, setUploadBoard] = useState<string>("")
  const [uploadMode, setUploadMode] = useState<"file" | "text">("file")
  const [csvFile, setCsvFile] = useState<File | null>(null)
  const [csvText, setCsvText] = useState("")
  const [parsePreview, setParsePreview] = useState<any[] | null>(null)
  const [parseErrors, setParseErrors] = useState<ParseError[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadResult, setUploadResult] = useState<{ batchId: string; inserted: number; skipped: number } | null>(null)

  // Orders state
  const [orders, setOrders] = useState<RCOrder[]>([])
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [ordersTotal, setOrdersTotal] = useState(0)
  const [orderStats, setOrderStats] = useState<any>(null)
  const [orderBoardFilter, setOrderBoardFilter] = useState("all")
  const [orderStatusFilter, setOrderStatusFilter] = useState("all")
  const [orderSearch, setOrderSearch] = useState("")

  // Settings state
  const [settings, setSettings] = useState<Record<string, any>>({})
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null)
    })
  }, [])

  useEffect(() => {
    if (token) {
      loadInventory()
      loadAdminSettings()
    }
  }, [token, invBoardFilter, invStatusFilter])

  useEffect(() => {
    if (token && activeTab === "orders") loadOrders()
  }, [token, activeTab, orderBoardFilter, orderStatusFilter, orderSearch])

  // ─── Inventory ───────────────────────────────────────────────

  const loadInventory = useCallback(async () => {
    if (!token) return
    setInventoryLoading(true)
    try {
      const params = new URLSearchParams({ limit: "50" })
      if (invBoardFilter !== "all") params.set("examBoard", invBoardFilter)
      if (invStatusFilter !== "all") params.set("status", invStatusFilter)

      const res = await fetch(`/api/admin/results-checker/inventory?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (res.ok) {
        setInventoryItems(data.items ?? [])
        setInventoryTotal(data.total ?? 0)
        setSummary(data.summary ?? null)
      }
    } finally {
      setInventoryLoading(false)
    }
  }, [token, invBoardFilter, invStatusFilter])

  const handleMarkInvalid = async () => {
    if (selectedIds.size === 0) return
    const confirmed = confirm(`Mark ${selectedIds.size} voucher(s) as invalid?`)
    if (!confirmed) return
    const res = await fetch("/api/admin/results-checker/inventory", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mark_invalid", ids: Array.from(selectedIds) }),
    })
    if (res.ok) {
      toast.success(`${selectedIds.size} voucher(s) marked as invalid`)
      setSelectedIds(new Set())
      loadInventory()
    } else {
      toast.error("Failed to mark invalid")
    }
  }

  // ─── CSV Upload ───────────────────────────────────────────────

  const PIN_REGEX = /^\d{10,12}$/
  const SERIAL_REGEX = /^[A-Za-z0-9]+$/

  const handleDownloadTemplate = async () => {
    const { utils, write } = await import("xlsx")
    const rows = [
      ["pin", "serial_number", "expiry_date", "notes"],
      ["123456789012", "SN001", "2027-01-01", "Sample batch A"],
      ["987654321098", "SN002", "2027-06-30", "Sample batch A"],
      ["555444333222", "",      "",            ""],
    ]
    const ws = utils.aoa_to_sheet(rows)
    ws["!cols"] = [{ wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 20 }]
    const wb = utils.book_new()
    utils.book_append_sheet(wb, ws, "Vouchers")
    const buf = write(wb, { type: "array", bookType: "xlsx" })
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "voucher_upload_template.xlsx"
    a.click()
    URL.revokeObjectURL(url)
  }

  // File mode: preview first 5 rows (columns: pin, serial, expiry, notes)
  const previewCsvText = (text: string) => {
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean)
    const startIdx = lines[0]?.toLowerCase().startsWith("pin") || lines[0]?.toLowerCase().startsWith("exam_board") ? 1 : 0
    const preview = lines.slice(startIdx, startIdx + 5).map(l => l.split(",").map(c => c.trim()))
    setParsePreview(preview.length ? preview : null)
  }

  // Text/paste mode: parse alternating serial/pin pairs
  const previewPairText = (text: string, board: string) => {
    const lines = text.split("\n").map(l => l.trim())
    const previewRows: { board: string; pin: string; serial: string; error?: string }[] = []
    const errs: ParseError[] = []
    let rowNum = 0

    for (let i = 0; i < lines.length; i += 2) {
      const serial = lines[i] ?? ""
      const pin = lines[i + 1] ?? ""
      if (!serial && !pin) continue
      rowNum++
      if (!pin) {
        errs.push({ row: rowNum, reason: "Missing PIN line (each serial must be followed by a PIN)", raw: serial })
      } else if (!PIN_REGEX.test(pin)) {
        errs.push({ row: rowNum, reason: `PIN "${pin}" must be 10–12 digits (numeric only)`, raw: `${serial}\n${pin}` })
      } else if (serial && !SERIAL_REGEX.test(serial)) {
        errs.push({ row: rowNum, reason: `Serial "${serial}" must be alphanumeric`, raw: `${serial}\n${pin}` })
      } else if (previewRows.length < 5) {
        previewRows.push({ board: board || "—", pin, serial: serial || "—" })
      }
    }

    setParsePreview(previewRows.length ? previewRows : null)
    setParseErrors(errs)
  }

  const handleFileSelect = async (file: File) => {
    setCsvFile(file)
    setUploadResult(null)
    setParseErrors([])
    setParsePreview(null)
    const text = await file.text()
    previewCsvText(text)
  }

  const handleTextChange = (text: string) => {
    setCsvText(text)
    setUploadResult(null)
    previewPairText(text, uploadBoard)
  }

  const handleUpload = async () => {
    if (!token) return
    if (!uploadBoard) { toast.error("Select an exam board first"); return }
    const hasFile = uploadMode === "file" && csvFile
    const hasText = uploadMode === "text" && csvText.trim()
    if (!hasFile && !hasText) return

    setUploading(true)
    try {
      let file: File
      if (hasFile) {
        file = csvFile!
      } else {
        // Convert serial/pin pairs to CSV: board,pin,serial
        const lines = csvText.split("\n").map(l => l.trim())
        const csvLines: string[] = []
        for (let i = 0; i < lines.length; i += 2) {
          const serial = lines[i] ?? ""
          const pin = lines[i + 1] ?? ""
          if (!serial && !pin) continue
          csvLines.push(`${uploadBoard},${pin},${serial}`)
        }
        file = new File([csvLines.join("\n")], "vouchers.csv", { type: "text/csv" })
      }

      const formData = new FormData()
      formData.append("file", file)
      formData.append("board", uploadBoard)
      const res = await fetch("/api/admin/results-checker/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })
      const data = await res.json()
      if (res.ok) {
        setUploadResult({ batchId: data.batchId, inserted: data.inserted, skipped: data.skipped })
        setParseErrors(data.parseErrors ?? [])
        toast.success(data.message)
        setCsvFile(null)
        setCsvText("")
        setParsePreview(null)
        loadInventory()
      } else {
        toast.error(data.error ?? "Upload failed")
        setParseErrors(data.parseErrors ?? [])
      }
    } finally {
      setUploading(false)
    }
  }

  // ─── Orders ──────────────────────────────────────────────────

  const loadOrders = useCallback(async () => {
    if (!token) return
    setOrdersLoading(true)
    try {
      const params = new URLSearchParams({ limit: "50" })
      if (orderBoardFilter !== "all") params.set("examBoard", orderBoardFilter)
      if (orderStatusFilter !== "all") params.set("status", orderStatusFilter)
      if (orderSearch) params.set("search", orderSearch)

      const res = await fetch(`/api/admin/results-checker/list?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (res.ok) {
        setOrders(data.orders ?? [])
        setOrdersTotal(data.total ?? 0)
        setOrderStats(data.stats ?? null)
      }
    } finally {
      setOrdersLoading(false)
    }
  }, [token, orderBoardFilter, orderStatusFilter, orderSearch])

  const handleFailOrder = async (orderId: string) => {
    const confirmed = confirm("Mark this order as failed and refund the customer?")
    if (!confirmed) return
    const res = await fetch("/api/admin/results-checker/action", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ orderId, action: "failed" }),
    })
    const data = await res.json()
    if (res.ok) {
      toast.success(data.message)
      loadOrders()
    } else {
      toast.error(data.error ?? "Action failed")
    }
  }

  // ─── Settings ────────────────────────────────────────────────

  const loadAdminSettings = async () => {
    if (!token) return
    setSettingsLoading(true)
    try {
      const res = await fetch("/api/admin/results-checker/settings", {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (res.ok) setSettings(data.settings ?? {})
    } finally {
      setSettingsLoading(false)
    }
  }

  const handleSaveSettings = async () => {
    if (!token) return
    setSavingSettings(true)
    try {
      const res = await fetch("/api/admin/results-checker/settings", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to save settings")
      toast.success("Settings saved")
    } catch (err: any) {
      toast.error(err.message ?? "Failed to save settings")
    } finally {
      setSavingSettings(false)
    }
  }

  const setSetting = (key: string, field: string, value: any) => {
    setSettings(prev => ({ ...prev, [key]: { ...prev[key], [field]: value } }))
  }

  if (adminLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-violet-600" />
        </div>
      </DashboardLayout>
    )
  }

  if (!isAdmin) return null

  const lowStockBoards = EXAM_BOARDS.filter(b => (summary?.[b.toLowerCase() as keyof InventorySummary]?.available ?? 0) < 50)

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Results Checker Vouchers</h1>
          <p className="text-gray-500 text-sm mt-1">Manage WAEC, BECE &amp; NOVDEC voucher inventory and orders</p>
        </div>

        {lowStockBoards.length > 0 && (
          <div className="flex items-center gap-2 px-4 py-3 bg-orange-50 border border-orange-200 rounded-lg text-orange-800 text-sm font-medium">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            Low stock alert: {lowStockBoards.map(b => `${b} (${summary?.[b.toLowerCase() as keyof InventorySummary]?.available ?? 0} left)`).join(", ")}
          </div>
        )}

        <Tabs value={activeTab} onValueChange={v => setActiveTab(v as any)}>
          <TabsList className="grid grid-cols-4 w-full max-w-lg">
            <TabsTrigger value="inventory"><Package className="w-4 h-4 mr-1" />Inventory</TabsTrigger>
            <TabsTrigger value="upload"><Upload className="w-4 h-4 mr-1" />Upload</TabsTrigger>
            <TabsTrigger value="orders"><ShoppingCart className="w-4 h-4 mr-1" />Orders</TabsTrigger>
            <TabsTrigger value="settings"><Settings className="w-4 h-4 mr-1" />Settings</TabsTrigger>
          </TabsList>

          {/* ── Inventory Tab ─────────────────────────────── */}
          <TabsContent value="inventory" className="space-y-4 mt-4">
            {/* Summary Cards */}
            <div className="grid grid-cols-3 gap-4">
              {EXAM_BOARDS.map(board => {
                const s = summary?.[board.toLowerCase() as keyof InventorySummary]
                return (
                  <Card key={board}>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-semibold text-gray-700">{board}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-1 text-sm">
                      <div className="flex justify-between"><span className="text-green-600 font-medium">Available</span><span className="font-bold">{s?.available ?? 0}</span></div>
                      <div className="flex justify-between"><span className="text-yellow-600">Reserved</span><span>{s?.reserved ?? 0}</span></div>
                      <div className="flex justify-between"><span className="text-blue-600">Sold</span><span>{s?.sold ?? 0}</span></div>
                      <div className="flex justify-between"><span className="text-red-500">Invalid</span><span>{s?.invalid ?? 0}</span></div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>

            {/* Filters */}
            <div className="flex gap-3 items-center">
              <select value={invBoardFilter} onChange={e => setInvBoardFilter(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
                <option value="all">All Boards</option>
                {EXAM_BOARDS.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
              <select value={invStatusFilter} onChange={e => setInvStatusFilter(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
                <option value="all">All Statuses</option>
                {["available","reserved","sold","used","expired","invalid"].map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <Button variant="outline" size="sm" onClick={loadInventory}><RefreshCw className="w-4 h-4 mr-1" />Refresh</Button>
              {selectedIds.size > 0 && (
                <Button variant="destructive" size="sm" onClick={handleMarkInvalid}>
                  <XCircle className="w-4 h-4 mr-1" />Mark {selectedIds.size} Invalid
                </Button>
              )}
              <span className="text-sm text-gray-500 ml-auto">{inventoryTotal} total</span>
            </div>

            {/* Table */}
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
                  <tr>
                    <th className="px-4 py-3 text-left w-8">
                      <input type="checkbox" onChange={e => {
                        if (e.target.checked) setSelectedIds(new Set(inventoryItems.map(i => i.id)))
                        else setSelectedIds(new Set())
                      }} />
                    </th>
                    <th className="px-4 py-3 text-left">Board</th>
                    <th className="px-4 py-3 text-left">PIN</th>
                    <th className="px-4 py-3 text-left">Serial</th>
                    <th className="px-4 py-3 text-left">Status</th>
                    <th className="px-4 py-3 text-left">Batch</th>
                    <th className="px-4 py-3 text-left">Expires</th>
                    <th className="px-4 py-3 text-left">Uploaded</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {inventoryLoading ? (
                    <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></td></tr>
                  ) : inventoryItems.length === 0 ? (
                    <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400">No vouchers found</td></tr>
                  ) : inventoryItems.map(item => (
                    <tr key={item.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <input type="checkbox" checked={selectedIds.has(item.id)}
                          onChange={e => {
                            const next = new Set(selectedIds)
                            e.target.checked ? next.add(item.id) : next.delete(item.id)
                            setSelectedIds(next)
                          }} />
                      </td>
                      <td className="px-4 py-3 font-semibold">{item.exam_board}</td>
                      <td className="px-4 py-3 font-mono">{item.pin}</td>
                      <td className="px-4 py-3 font-mono text-gray-500">{item.serial_number ?? "—"}</td>
                      <td className="px-4 py-3"><Badge className={STATUS_CLASSES[item.status] ?? ""}>{item.status}</Badge></td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{item.batch_id ?? "—"}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{item.expiry_date ?? "—"}</td>
                      <td className="px-4 py-3 text-gray-400 text-xs">{new Date(item.created_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </TabsContent>

          {/* ── Upload Tab ────────────────────────────────── */}
          <TabsContent value="upload" className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Upload Vouchers</CardTitle>
                  <Button variant="outline" size="sm" onClick={handleDownloadTemplate}>
                    <Download className="w-4 h-4 mr-2" />Download Template
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-5">

                {/* Board selector — required before upload */}
                <div>
                  <Label className="text-sm font-semibold text-gray-700">Exam Board <span className="text-red-500">*</span></Label>
                  <div className="flex gap-2 mt-2">
                    {EXAM_BOARDS.map(b => (
                      <button key={b} onClick={() => { setUploadBoard(b); setParsePreview(null); setParseErrors([]); setUploadResult(null) }}
                        className={`px-5 py-2 rounded-lg font-bold text-sm border-2 transition-all ${
                          uploadBoard === b
                            ? "border-violet-600 bg-violet-50 text-violet-700 shadow-sm"
                            : "border-gray-200 text-gray-500 hover:border-violet-300"
                        }`}
                      >{b}</button>
                    ))}
                  </div>
                  {!uploadBoard && <p className="text-xs text-amber-600 mt-1">Select a board to enable upload</p>}
                </div>

                {/* Mode toggle */}
                <div className="flex gap-2">
                  <button onClick={() => { setUploadMode("file"); setParsePreview(null); setParseErrors([]) }}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${uploadMode === "file" ? "bg-violet-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                  >File Upload</button>
                  <button onClick={() => { setUploadMode("text"); setParsePreview(null); setParseErrors([]) }}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${uploadMode === "text" ? "bg-violet-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                  >Paste / Type</button>
                </div>

                {uploadMode === "file" ? (
                  <>
                    <p className="text-xs text-gray-400">File columns: <code className="bg-gray-100 px-1 rounded">pin, serial_number, expiry_date, notes</code> — no exam_board column needed</p>
                    <div
                      className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center cursor-pointer hover:border-violet-400 transition-colors"
                      onClick={() => document.getElementById("csv-input")?.click()}
                      onDragOver={e => e.preventDefault()}
                      onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFileSelect(f) }}
                    >
                      <Upload className="w-8 h-8 mx-auto text-gray-400 mb-2" />
                      {csvFile ? (
                        <p className="text-sm font-medium text-violet-700">{csvFile.name} ({(csvFile.size / 1024).toFixed(1)} KB)</p>
                      ) : (
                        <p className="text-sm text-gray-500">Drag &amp; drop a .xlsx or .csv file, or click to browse</p>
                      )}
                      <input id="csv-input" type="file" accept=".csv,.xlsx,.xls" className="hidden"
                        onChange={e => { const f = e.target.files?.[0]; if (f) handleFileSelect(f) }} />
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-gray-400">
                      Paste serial/PIN pairs — <strong>serial number on odd lines, PIN on even lines</strong>, repeat for each voucher.
                      PINs must be 10–12 digits. Leave serial blank (empty line) if not available.
                    </p>
                    <textarea
                      value={csvText}
                      onChange={e => handleTextChange(e.target.value)}
                      placeholder={"WGR1900112581\n123456789012\nWGR1900112582\n987654321098\n\n(blank serial below means no serial)\n\n456789012345"}
                      rows={12}
                      className="w-full font-mono text-sm border rounded-lg p-3 resize-y focus:outline-none focus:ring-2 focus:ring-violet-400"
                    />
                  </>
                )}

                {/* Preview */}
                {parsePreview && parsePreview.length > 0 && (
                  <div>
                    <p className="text-sm font-medium text-gray-700 mb-2">Preview (first 5 rows)</p>
                    <div className="rounded-lg border overflow-hidden">
                      <table className="w-full text-xs">
                        {uploadMode === "text" ? (
                          <>
                            <thead className="bg-gray-50"><tr>{["#","Board","PIN","Serial"].map(h => <th key={h} className="px-3 py-2 text-left text-gray-500">{h}</th>)}</tr></thead>
                            <tbody className="divide-y">
                              {(parsePreview as any[]).map((row, i) => (
                                <tr key={i}>
                                  <td className="px-3 py-2 text-gray-400">{i + 1}</td>
                                  <td className="px-3 py-2 font-semibold text-violet-700">{row.board}</td>
                                  <td className="px-3 py-2 font-mono">{row.pin}</td>
                                  <td className="px-3 py-2 font-mono text-gray-500">{row.serial}</td>
                                </tr>
                              ))}
                            </tbody>
                          </>
                        ) : (
                          <>
                            <thead className="bg-gray-50"><tr>{["PIN","Serial","Expiry","Notes"].map(h => <th key={h} className="px-3 py-2 text-left text-gray-500">{h}</th>)}</tr></thead>
                            <tbody className="divide-y">
                              {(parsePreview as string[][]).map((row, i) => (
                                <tr key={i}>{row.map((cell: string, j: number) => <td key={j} className="px-3 py-2 font-mono">{cell || "—"}</td>)}</tr>
                              ))}
                            </tbody>
                          </>
                        )}
                      </table>
                    </div>
                  </div>
                )}

                {/* Parse errors */}
                {parseErrors.length > 0 && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3 space-y-1">
                    <p className="text-sm font-semibold text-red-700">{parseErrors.length} row error{parseErrors.length > 1 ? "s" : ""}</p>
                    {parseErrors.slice(0, 5).map(e => (
                      <p key={e.row} className="text-xs text-red-600">Row {e.row}: {e.reason}</p>
                    ))}
                    {parseErrors.length > 5 && <p className="text-xs text-red-500">…and {parseErrors.length - 5} more</p>}
                  </div>
                )}

                {/* Upload result */}
                {uploadResult && (
                  <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-800">
                    <p className="font-semibold">Upload complete</p>
                    <p>{uploadResult.inserted} inserted · {uploadResult.skipped} duplicates skipped</p>
                    <p className="text-xs text-green-600 mt-1">Batch ID: {uploadResult.batchId}</p>
                  </div>
                )}

                <Button
                  onClick={handleUpload}
                  disabled={!uploadBoard || (uploadMode === "file" ? !csvFile : !csvText.trim()) || uploading}
                  className="w-full"
                >
                  {uploading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Uploading…</> : <><Upload className="w-4 h-4 mr-2" />Upload Vouchers</>}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Orders Tab ────────────────────────────────── */}
          <TabsContent value="orders" className="space-y-4 mt-4">
            {/* Stats */}
            {orderStats && (
              <div className="grid grid-cols-4 gap-4">
                {[
                  { label: "Total Orders", value: orderStats.total },
                  { label: "Revenue", value: `GHS ${Number(orderStats.revenue).toFixed(2)}` },
                  { label: "Merchant Payouts", value: `GHS ${Number(orderStats.merchantPayouts).toFixed(2)}` },
                  { label: "Completed", value: orderStats.byStatus?.completed ?? 0 },
                ].map(({ label, value }) => (
                  <Card key={label}>
                    <CardContent className="pt-4">
                      <p className="text-xs text-gray-500">{label}</p>
                      <p className="text-xl font-bold text-gray-900">{value}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            {/* Filters */}
            <div className="flex gap-3 items-center flex-wrap">
              <select value={orderBoardFilter} onChange={e => setOrderBoardFilter(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
                <option value="all">All Boards</option>
                {EXAM_BOARDS.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
              <select value={orderStatusFilter} onChange={e => setOrderStatusFilter(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
                <option value="all">All Statuses</option>
                {["pending","pending_payment","completed","failed"].map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input value={orderSearch} onChange={e => setOrderSearch(e.target.value)}
                  placeholder="Search reference or email…" className="pl-9 pr-4 py-2 border rounded-lg text-sm w-64" />
              </div>
              <Button variant="outline" size="sm" onClick={loadOrders}><RefreshCw className="w-4 h-4 mr-1" />Refresh</Button>
              <span className="text-sm text-gray-500 ml-auto">{ordersTotal} total</span>
            </div>

            {/* Table */}
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
                  <tr>
                    <th className="px-4 py-3 text-left">Reference</th>
                    <th className="px-4 py-3 text-left">Board</th>
                    <th className="px-4 py-3 text-left">Qty</th>
                    <th className="px-4 py-3 text-left">Total</th>
                    <th className="px-4 py-3 text-left">Customer</th>
                    <th className="px-4 py-3 text-left">Shop</th>
                    <th className="px-4 py-3 text-left">Status</th>
                    <th className="px-4 py-3 text-left">Date</th>
                    <th className="px-4 py-3 text-left">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {ordersLoading ? (
                    <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-400"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></td></tr>
                  ) : orders.length === 0 ? (
                    <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-400">No orders found</td></tr>
                  ) : orders.map(order => (
                    <tr key={order.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-mono text-xs font-semibold">{order.reference_code}</td>
                      <td className="px-4 py-3"><Badge variant="outline">{order.exam_board}</Badge></td>
                      <td className="px-4 py-3 text-center">{order.quantity}</td>
                      <td className="px-4 py-3 font-semibold">GHS {Number(order.total_paid).toFixed(2)}</td>
                      <td className="px-4 py-3 text-xs text-gray-500">{order.customer_email ?? order.users?.email ?? "—"}</td>
                      <td className="px-4 py-3 text-xs text-gray-500">{order.user_shops?.shop_name ?? "—"}</td>
                      <td className="px-4 py-3"><Badge className={STATUS_CLASSES[order.status] ?? ""}>{order.status}</Badge></td>
                      <td className="px-4 py-3 text-xs text-gray-400">{new Date(order.created_at).toLocaleDateString()}</td>
                      <td className="px-4 py-3">
                        {order.status !== "failed" && order.status !== "completed" && (
                          <Button variant="destructive" size="sm" onClick={() => handleFailOrder(order.id)}>Refund</Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </TabsContent>

          {/* ── Settings Tab ──────────────────────────────── */}
          <TabsContent value="settings" className="space-y-4 mt-4">
            <Card>
              <CardHeader><CardTitle className="text-base">Pricing &amp; Limits</CardTitle></CardHeader>
              <CardContent className="space-y-6">
                {EXAM_BOARDS.map(board => {
                  const bk = board.toLowerCase()
                  return (
                    <div key={board} className="space-y-3 pb-4 border-b last:border-0">
                      <div className="flex items-center justify-between">
                        <h3 className="font-semibold text-gray-800">{board}</h3>
                        <label className="flex items-center gap-2 text-sm">
                          <input type="checkbox"
                            checked={settings[`results_checker_enabled_${bk}`]?.enabled !== false}
                            onChange={e => setSetting(`results_checker_enabled_${bk}`, "enabled", e.target.checked)}
                          />
                          Enabled
                        </label>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label className="text-xs text-gray-500">Base Price (GHS)</Label>
                          <Input type="number" step="0.01" min="0"
                            value={settings[`results_checker_price_${bk}`]?.price ?? ""}
                            onChange={e => setSetting(`results_checker_price_${bk}`, "price", parseFloat(e.target.value))}
                            className="mt-1" />
                        </div>
                        <div>
                          <Label className="text-xs text-gray-500">Max Shop Markup (GHS per voucher)</Label>
                          <Input type="number" step="0.01" min="0"
                            value={settings[`results_checker_max_markup_${bk}`]?.max ?? ""}
                            onChange={e => setSetting(`results_checker_max_markup_${bk}`, "max", parseFloat(e.target.value))}
                            className="mt-1" />
                        </div>
                      </div>
                    </div>
                  )
                })}
                <div className="grid grid-cols-2 gap-4 pt-2">
                  <div>
                    <Label className="text-xs text-gray-500">Max Vouchers Per Order</Label>
                    <Input type="number" min="1"
                      value={settings["results_checker_max_quantity"]?.max ?? ""}
                      onChange={e => setSetting("results_checker_max_quantity", "max", parseInt(e.target.value))}
                      className="mt-1" />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500">Reservation Timeout (minutes)</Label>
                    <Input type="number" min="1"
                      value={settings["results_checker_reservation_timeout"]?.minutes ?? ""}
                      onChange={e => setSetting("results_checker_reservation_timeout", "minutes", parseInt(e.target.value))}
                      className="mt-1" />
                  </div>
                </div>
                <Button onClick={handleSaveSettings} disabled={savingSettings} className="w-full">
                  {savingSettings ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save Settings"}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  )
}
