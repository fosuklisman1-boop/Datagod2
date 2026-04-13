"use client"

import { useEffect, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Settings,
  Copy,
  Check,
  Search,
  Loader2,
  Zap,
  WifiOff,
  RefreshCw,
  Play,
  AlertCircle,
} from "lucide-react"
import { useAdminProtected } from "@/hooks/use-admin"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"

interface AFASubmission {
  id: string
  user_id: string
  phone_number: string
  gh_card_number?: string
  location?: string
  region?: string
  occupation?: string
  full_name?: string
  amount: number
  status: "pending" | "processing" | "completed" | "cancelled"
  fulfillment_status?: "unfulfilled" | "pending" | "fulfilled" | "failed"
  fulfillment_ref?: string
  fulfillment_error?: string
  fulfilled_at?: string
  fulfillment_attempts?: number
  created_at: string
  user_email: string
  transaction_code?: string
  order_code: string
}

interface AFASettings {
  price: number
}

export default function AFAManagementPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()

  const [settings, setSettings] = useState<AFASettings>({ price: 50 })
  const [submissions, setSubmissions] = useState<AFASubmission[]>([])
  const [filteredSubmissions, setFilteredSubmissions] = useState<AFASubmission[]>([])
  const [loading, setLoading] = useState(true)
  const [savingPrice, setSavingPrice] = useState(false)
  const [searchTerm, setSearchTerm] = useState("")
  const [filterStatus, setFilterStatus] = useState<string>("all")
  const [filterFulfillment, setFilterFulfillment] = useState<string>("all")
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [updatingId, setUpdatingId] = useState<string | null>(null)

  // Auto-fulfillment toggle state
  const [autoFulfillEnabled, setAutoFulfillEnabled] = useState(false)
  const [loadingToggle, setLoadingToggle] = useState(true)
  const [togglingAutoFulfill, setTogglingAutoFulfill] = useState(false)

  // Per-row and bulk fulfillment state
  const [fulfillingId, setFulfillingId] = useState<string | null>(null)
  const [bulkFulfilling, setBulkFulfilling] = useState(false)

  useEffect(() => {
    if (isAdmin && !adminLoading) {
      loadSettings()
      loadSubmissions()
      loadAutoFulfillSetting()
    }
  }, [isAdmin, adminLoading])

  useEffect(() => {
    filterSubmissions()
  }, [submissions, searchTerm, filterStatus, filterFulfillment])

  const getAuthHeader = async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) throw new Error("Authentication required")
    return { Authorization: `Bearer ${session.access_token}` }
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  const loadSettings = async () => {
    try {
      const response = await fetch("/api/afa/price")
      if (!response.ok) throw new Error("Failed to fetch price")
      const data = await response.json()
      setSettings({ price: data.price || 50 })
    } catch (error) {
      console.error("Error loading settings:", error)
      toast.error(error instanceof Error ? error.message : "Failed to load AFA settings")
    }
  }

  const handleSavePrice = async () => {
    try {
      setSavingPrice(true)
      const headers = await getAuthHeader()
      const response = await fetch("/api/afa/price", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ price: settings.price }),
      })
      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || "Failed to update price")
      }
      toast.success("AFA price updated successfully")
      await loadSettings()
    } catch (error) {
      console.error("Error saving price:", error)
      toast.error(error instanceof Error ? error.message : "Failed to save AFA price")
    } finally {
      setSavingPrice(false)
    }
  }

  // ── Submissions ───────────────────────────────────────────────────────────

  const loadSubmissions = async () => {
    try {
      setLoading(true)
      const headers = await getAuthHeader()
      const response = await fetch("/api/admin/afa-registrations", { headers })
      if (!response.ok) throw new Error("Failed to fetch submissions")
      const data = await response.json()
      setSubmissions(data.submissions || [])
    } catch (error) {
      console.error("Error loading submissions:", error)
      toast.error(error instanceof Error ? error.message : "Failed to load AFA submissions")
    } finally {
      setLoading(false)
    }
  }

  const updateStatus = async (submissionId: string, newStatus: string) => {
    try {
      setUpdatingId(submissionId)
      const headers = await getAuthHeader()
      const response = await fetch("/api/admin/afa-update-status", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ submissionId, status: newStatus }),
      })
      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || "Failed to update status")
      }
      setSubmissions(
        submissions.map((sub) =>
          sub.id === submissionId ? { ...sub, status: newStatus as AFASubmission["status"] } : sub
        )
      )
      toast.success("Status updated successfully")
    } catch (error) {
      console.error("Error updating status:", error)
      toast.error(error instanceof Error ? error.message : "Failed to update status")
    } finally {
      setUpdatingId(null)
    }
  }

  const filterSubmissions = () => {
    let filtered = submissions

    if (searchTerm) {
      const term = searchTerm.toLowerCase()
      filtered = filtered.filter(
        (sub) =>
          sub.user_email?.toLowerCase().includes(term) ||
          sub.phone_number?.includes(term) ||
          sub.gh_card_number?.toLowerCase().includes(term) ||
          sub.location?.toLowerCase().includes(term) ||
          sub.region?.toLowerCase().includes(term) ||
          sub.full_name?.toLowerCase().includes(term) ||
          sub.order_code?.toLowerCase().includes(term) ||
          sub.transaction_code?.toLowerCase().includes(term)
      )
    }

    if (filterStatus !== "all") {
      filtered = filtered.filter((sub) => sub.status === filterStatus)
    }

    if (filterFulfillment !== "all") {
      filtered = filtered.filter((sub) =>
        (sub.fulfillment_status || "unfulfilled") === filterFulfillment
      )
    }

    setFilteredSubmissions(filtered)
  }

  const copyToClipboard = (submission: AFASubmission) => {
    const textToCopy = `Full Name: ${submission.full_name || "N/A"}
Phone Number: ${submission.phone_number || "N/A"}
GH Card Number: ${submission.gh_card_number || "N/A"}
Location: ${submission.location || "N/A"}
Region: ${submission.region || "N/A"}
Occupation: ${submission.occupation || "N/A"}`

    navigator.clipboard.writeText(textToCopy)
    setCopiedId(`full-${submission.id}`)
    toast.success("Copied to clipboard")
    setTimeout(() => setCopiedId(null), 2000)
  }

  // ── Auto-fulfillment toggle ───────────────────────────────────────────────

  const loadAutoFulfillSetting = async () => {
    try {
      setLoadingToggle(true)
      const headers = await getAuthHeader()
      const response = await fetch("/api/admin/settings/afa-auto-fulfillment", { headers })
      if (!response.ok) throw new Error("Failed to load setting")
      const data = await response.json()
      setAutoFulfillEnabled(data.enabled)
    } catch (error) {
      console.error("Error loading auto-fulfillment setting:", error)
    } finally {
      setLoadingToggle(false)
    }
  }

  const handleToggleAutoFulfill = async () => {
    try {
      setTogglingAutoFulfill(true)
      const headers = await getAuthHeader()
      const response = await fetch("/api/admin/settings/afa-auto-fulfillment", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ enabled: !autoFulfillEnabled }),
      })
      if (!response.ok) throw new Error("Failed to update setting")
      const data = await response.json()
      setAutoFulfillEnabled(data.enabled)
      toast.success(data.message)
    } catch (error) {
      console.error("Error toggling auto-fulfillment:", error)
      toast.error("Failed to update auto-fulfillment setting")
    } finally {
      setTogglingAutoFulfill(false)
    }
  }

  // ── Per-order fulfillment ─────────────────────────────────────────────────

  const handleFulfillOrder = async (orderId: string) => {
    try {
      setFulfillingId(orderId)
      const headers = await getAuthHeader()
      const response = await fetch("/api/admin/afa-fulfillment", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ action: "fulfill-one", orderId }),
      })
      const data = await response.json()
      if (data.success) {
        toast.success("Order fulfilled successfully")
        await loadSubmissions()
      } else {
        toast.error(data.message || "Fulfillment failed")
      }
    } catch (error) {
      console.error("Error fulfilling order:", error)
      toast.error("Failed to fulfill order")
    } finally {
      setFulfillingId(null)
    }
  }

  // ── Bulk fulfillment ──────────────────────────────────────────────────────

  const handleFulfillAllPending = async () => {
    try {
      setBulkFulfilling(true)
      const headers = await getAuthHeader()
      const response = await fetch("/api/admin/afa-fulfillment", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ action: "fulfill-pending" }),
      })
      const data = await response.json()
      toast.success(data.message || `Processed: ${data.fulfilled} fulfilled, ${data.failed} failed`)
      await loadSubmissions()
    } catch (error) {
      console.error("Error bulk fulfilling:", error)
      toast.error("Bulk fulfillment failed")
    } finally {
      setBulkFulfilling(false)
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed":  return "bg-green-100 text-green-800"
      case "processing": return "bg-blue-100 text-blue-800"
      case "pending":    return "bg-yellow-100 text-yellow-800"
      case "cancelled":  return "bg-red-100 text-red-800"
      default:           return "bg-gray-100 text-gray-800"
    }
  }

  const getFulfillmentBadge = (sub: AFASubmission) => {
    const fs = sub.fulfillment_status || "unfulfilled"
    switch (fs) {
      case "fulfilled":
        return <Badge className="bg-green-100 text-green-800 text-xs">Fulfilled</Badge>
      case "pending":
        return <Badge className="bg-blue-100 text-blue-800 text-xs">Fulfilling…</Badge>
      case "failed":
        return (
          <span title={sub.fulfillment_error || "Unknown error"}>
            <Badge className="bg-red-100 text-red-800 text-xs cursor-help">Failed ⚠</Badge>
          </span>
        )
      default:
        return <Badge className="bg-gray-100 text-gray-700 text-xs">Unfulfilled</Badge>
    }
  }

  const unfulfilled = submissions.filter(
    (s) => (!s.fulfillment_status || s.fulfillment_status === "unfulfilled" || s.fulfillment_status === "failed") && s.status !== "cancelled"
  ).length

  const stats = {
    total:      submissions.length,
    pending:    submissions.filter((s) => s.status === "pending").length,
    processing: submissions.filter((s) => s.status === "processing").length,
    completed:  submissions.filter((s) => s.status === "completed").length,
    unfulfilled,
    fulfilled:  submissions.filter((s) => s.fulfillment_status === "fulfilled").length,
    failedFulfillment: submissions.filter((s) => s.fulfillment_status === "failed").length,
  }

  if (adminLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <p className="text-gray-500">Loading...</p>
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
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold bg-gradient-to-r from-cyan-600 via-blue-600 to-purple-600 bg-clip-text text-transparent">
            AFA Management
          </h1>
          <p className="text-gray-500 mt-1 font-medium">Configure pricing, manage and fulfill AFA registrations</p>
        </div>

        {/* Auto-Fulfillment Toggle Card */}
        <Card className="border-l-4 border-l-purple-500 bg-gradient-to-br from-purple-50/60 to-blue-50/40 backdrop-blur-xl border border-purple-200/40">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="bg-gradient-to-br from-purple-400/30 to-blue-400/20 backdrop-blur p-2 rounded-lg border border-purple-300/60">
                <Zap className="h-5 w-5 text-purple-600" />
              </div>
              <div>
                <CardTitle>Auto-Fulfillment</CardTitle>
                <CardDescription>
                  When enabled, new AFA orders are automatically submitted to the Sykes API on placement
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {loadingToggle ? (
              <div className="flex items-center gap-2 text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">Loading setting...</span>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200">
                  <div className="space-y-1">
                    <p className="font-semibold text-gray-900">
                      {autoFulfillEnabled ? "🟢 ENABLED" : "⚪ DISABLED"}
                    </p>
                    <p className="text-sm text-gray-600">
                      {autoFulfillEnabled
                        ? "Orders are sent to Sykes API automatically on submission"
                        : "Orders wait in the queue for manual fulfillment below"}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Switch
                      checked={autoFulfillEnabled}
                      onCheckedChange={handleToggleAutoFulfill}
                      disabled={togglingAutoFulfill}
                    />
                    {togglingAutoFulfill && <Loader2 className="h-4 w-4 animate-spin text-purple-600" />}
                  </div>
                </div>

                <div className="grid md:grid-cols-2 gap-4 text-sm">
                  <div className="p-3 bg-purple-50 rounded-lg border border-purple-200">
                    <p className="font-medium text-purple-900 mb-1">🟢 When Enabled</p>
                    <ul className="text-xs space-y-1 text-purple-800">
                      <li>✓ Sykes API called on every new order</li>
                      <li>✓ Faster customer registration</li>
                      <li>✓ fulfillment_status tracked automatically</li>
                    </ul>
                  </div>
                  <div className="p-3 bg-amber-50 rounded-lg border border-amber-200">
                    <p className="font-medium text-amber-900 mb-1">⚪ When Disabled</p>
                    <ul className="text-xs space-y-1 text-amber-800">
                      <li>✓ Orders queue here for manual trigger</li>
                      <li>✓ Admin reviews before sending to Sykes</li>
                      <li>✓ Use "Fulfill Now" or "Fulfill All" below</li>
                    </ul>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Bulk Fulfillment Action */}
        <Card className="border-l-4 border-l-blue-500 bg-gradient-to-br from-blue-50/60 to-cyan-50/40 backdrop-blur-xl border border-blue-200/40">
          <CardHeader>
            <CardTitle className="text-base">Bulk Fulfillment</CardTitle>
            <CardDescription>
              Manually trigger Sykes registration for all unfulfilled / failed orders at once
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="space-y-1">
                <p className="text-sm text-gray-700">
                  <span className="font-semibold text-orange-600">{stats.unfulfilled}</span> order{stats.unfulfilled !== 1 ? "s" : ""} awaiting fulfillment
                  {stats.failedFulfillment > 0 && (
                    <span className="ml-2 text-red-600">({stats.failedFulfillment} previously failed — will retry)</span>
                  )}
                </p>
                <p className="text-xs text-gray-500">
                  {stats.fulfilled} fulfilled · {stats.total} total
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={loadSubmissions}
                  variant="outline"
                  size="sm"
                  disabled={loading}
                >
                  <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
                  Refresh
                </Button>
                <Button
                  onClick={handleFulfillAllPending}
                  disabled={bulkFulfilling || stats.unfulfilled === 0}
                  className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white font-semibold"
                >
                  {bulkFulfilling ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Fulfilling...
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4 mr-2" />
                      Fulfill All Pending ({stats.unfulfilled})
                    </>
                  )}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* AFA Price Settings */}
        <Card className="border-l-4 border-l-cyan-500 bg-gradient-to-br from-cyan-50/60 to-blue-50/40 backdrop-blur-xl border border-cyan-200/40">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="bg-gradient-to-br from-cyan-400/30 to-blue-400/20 backdrop-blur p-2 rounded-lg border border-cyan-300/60">
                <Settings className="h-5 w-5 text-cyan-600" />
              </div>
              <div>
                <CardTitle>AFA Price Configuration</CardTitle>
                <CardDescription>Set the price for AFA registration orders</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex gap-4 items-end">
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 mb-2">Price (GHS)</label>
                <Input
                  type="number"
                  min="1"
                  step="0.01"
                  value={settings.price}
                  onChange={(e) => setSettings({ price: parseFloat(e.target.value) || 0 })}
                  className="w-full"
                />
              </div>
              <Button
                onClick={handleSavePrice}
                disabled={savingPrice}
                className="bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-700 hover:to-blue-700 text-white font-semibold"
              >
                {savingPrice ? "Saving..." : "Save Price"}
              </Button>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Current AFA registration cost: GHS {(settings.price || 0).toFixed(2)}
            </p>
          </CardContent>
        </Card>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
          <Card className="bg-gradient-to-br from-blue-50/60 to-cyan-50/40 backdrop-blur-xl border border-blue-200/40">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-gray-900">Total</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-600">{stats.total}</div>
            </CardContent>
          </Card>

          <Card className="bg-gradient-to-br from-yellow-50/60 to-amber-50/40 backdrop-blur-xl border border-yellow-200/40">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-gray-900">Pending</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-yellow-600">{stats.pending}</div>
            </CardContent>
          </Card>

          <Card className="bg-gradient-to-br from-green-50/60 to-emerald-50/40 backdrop-blur-xl border border-green-200/40">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-gray-900">Fulfilled</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">{stats.fulfilled}</div>
            </CardContent>
          </Card>

          <Card className="bg-gradient-to-br from-red-50/60 to-orange-50/40 backdrop-blur-xl border border-red-200/40">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-gray-900">Failed</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-600">{stats.failedFulfillment}</div>
            </CardContent>
          </Card>
        </div>

        {/* Submissions List */}
        <Card className="border-l-4 border-l-blue-500 bg-gradient-to-br from-blue-50/60 to-cyan-50/40 backdrop-blur-xl border border-blue-200/40">
          <CardHeader>
            <CardTitle>AFA Submissions</CardTitle>
            <CardDescription>View, manage, and fulfill AFA registration submissions</CardDescription>
          </CardHeader>
          <CardContent>
            {/* Search and Filters */}
            <div className="flex gap-3 mb-6 flex-col sm:flex-row">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                <Input
                  placeholder="Search by email, phone, order code..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                />
              </div>
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-cyan-500 text-sm"
              >
                <option value="all">All Status</option>
                <option value="pending">Pending</option>
                <option value="processing">Processing</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
              <select
                value={filterFulfillment}
                onChange={(e) => setFilterFulfillment(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm"
              >
                <option value="all">All Fulfillment</option>
                <option value="unfulfilled">Unfulfilled</option>
                <option value="pending">Fulfilling</option>
                <option value="fulfilled">Fulfilled</option>
                <option value="failed">Failed</option>
              </select>
            </div>

            {/* Table */}
            {loading ? (
              <div className="text-center py-8 text-gray-500">
                <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" />
                Loading submissions...
              </div>
            ) : filteredSubmissions.length === 0 ? (
              <div className="text-center py-8 text-gray-500">No submissions found</div>
            ) : (
              <div className="space-y-4">
                {filteredSubmissions.map((submission) => (
                  <div key={submission.id} className="border border-gray-200 rounded-lg p-4 hover:bg-gray-50">
                    {/* Header Row */}
                    <div className="flex justify-between items-start mb-4 flex-wrap gap-2">
                      <div>
                        <p className="font-semibold text-gray-900">{submission.full_name || "N/A"}</p>
                        <p className="text-sm text-gray-600">{submission.user_email}</p>
                      </div>
                      <div className="flex gap-2 items-center flex-wrap">
                        {/* Order status badge */}
                        <Badge className={getStatusColor(submission.status)}>{submission.status}</Badge>

                        {/* Fulfillment status badge */}
                        {getFulfillmentBadge(submission)}

                        {/* Copy all button */}
                        <button
                          onClick={() => copyToClipboard(submission)}
                          className="flex items-center gap-1 bg-blue-50 text-blue-600 hover:bg-blue-100 px-3 py-1 rounded text-xs font-medium"
                        >
                          {copiedId === `full-${submission.id}` ? (
                            <><Check className="h-3 w-3" /> Copied</>
                          ) : (
                            <><Copy className="h-3 w-3" /> Copy All</>
                          )}
                        </button>

                        {/* Fulfill Now button — shown when not yet fulfilled */}
                        {submission.fulfillment_status !== "fulfilled" && submission.status !== "cancelled" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleFulfillOrder(submission.id)}
                            disabled={fulfillingId === submission.id || bulkFulfilling}
                            className="text-xs h-7 px-2 border-purple-300 text-purple-700 hover:bg-purple-50"
                          >
                            {fulfillingId === submission.id ? (
                              <><Loader2 className="h-3 w-3 animate-spin mr-1" /> Fulfilling</>
                            ) : (
                              <><Zap className="h-3 w-3 mr-1" /> Fulfill Now</>
                            )}
                          </Button>
                        )}

                        {/* Order status selector */}
                        <div className="flex gap-1 items-center">
                          <select
                            value={submission.status}
                            onChange={(e) => updateStatus(submission.id, e.target.value)}
                            disabled={updatingId === submission.id}
                            className="px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-cyan-500 disabled:opacity-50"
                          >
                            <option value="pending">Pending</option>
                            <option value="processing">Processing</option>
                            <option value="completed">Completed</option>
                            <option value="cancelled">Cancelled</option>
                          </select>
                          {updatingId === submission.id && (
                            <div className="flex items-center text-xs text-gray-500">
                              <Loader2 className="h-3 w-3 animate-spin mr-1" /> Updating...
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Details Grid */}
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                      <div className="bg-white border border-gray-200 rounded p-3">
                        <p className="text-xs text-gray-600 font-medium">Full Name</p>
                        <p className="mt-1 text-gray-900 text-sm font-mono">{submission.full_name || "N/A"}</p>
                      </div>

                      <div className="bg-white border border-gray-200 rounded p-3">
                        <p className="text-xs text-gray-600 font-medium">Phone</p>
                        <p className="mt-1 text-gray-900 text-sm font-mono">{submission.phone_number || "N/A"}</p>
                      </div>

                      <div className="bg-white border border-gray-200 rounded p-3">
                        <p className="text-xs text-gray-600 font-medium">GH Card</p>
                        <p className="mt-1 text-gray-900 text-sm font-mono">{submission.gh_card_number || "N/A"}</p>
                      </div>

                      <div className="bg-white border border-gray-200 rounded p-3">
                        <p className="text-xs text-gray-600 font-medium">Location</p>
                        <p className="mt-1 text-gray-900 text-sm font-mono">{submission.location || "N/A"}</p>
                      </div>

                      <div className="bg-white border border-gray-200 rounded p-3">
                        <p className="text-xs text-gray-600 font-medium">Region</p>
                        <p className="mt-1 text-gray-900 text-sm font-mono">{submission.region || "N/A"}</p>
                      </div>

                      <div className="bg-white border border-gray-200 rounded p-3">
                        <p className="text-xs text-gray-600 font-medium">Occupation</p>
                        <p className="mt-1 text-gray-900 text-sm font-mono">{submission.occupation || "N/A"}</p>
                      </div>

                      <div className="bg-white border border-gray-200 rounded p-3">
                        <p className="text-xs text-gray-600 font-medium">Order Code</p>
                        <p className="mt-1 text-gray-900 text-sm font-mono">{submission.order_code}</p>
                      </div>

                      <div className="bg-white border border-gray-200 rounded p-3">
                        <p className="text-xs text-gray-600 font-medium">Amount</p>
                        <p className="mt-1 text-gray-900 text-sm font-mono font-semibold">
                          GHS {(submission.amount || 0).toFixed(2)}
                        </p>
                      </div>

                      {/* Fulfillment info tile */}
                      <div className={`bg-white border rounded p-3 ${
                        submission.fulfillment_status === "fulfilled"
                          ? "border-green-300 bg-green-50"
                          : submission.fulfillment_status === "failed"
                          ? "border-red-300 bg-red-50"
                          : "border-gray-200"
                      }`}>
                        <p className="text-xs text-gray-600 font-medium">Fulfillment</p>
                        <div className="mt-1 space-y-1">
                          {getFulfillmentBadge(submission)}
                          {submission.fulfillment_ref && (
                            <p className="text-xs text-gray-600 font-mono truncate" title={submission.fulfillment_ref}>
                              Ref: {submission.fulfillment_ref}
                            </p>
                          )}
                          {submission.fulfillment_error && (
                            <p className="text-xs text-red-600 truncate" title={submission.fulfillment_error}>
                              {submission.fulfillment_error}
                            </p>
                          )}
                          {submission.fulfillment_attempts && submission.fulfillment_attempts > 0 && (
                            <p className="text-xs text-gray-400">
                              Attempts: {submission.fulfillment_attempts}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="bg-white border border-gray-200 rounded p-3">
                        <p className="text-xs text-gray-600 font-medium">Submitted</p>
                        <p className="mt-1 text-gray-900 text-sm font-mono">
                          {new Date(submission.created_at).toLocaleDateString()}
                        </p>
                      </div>
                    </div>

                    {/* Fulfillment error alert for failed orders */}
                    {submission.fulfillment_status === "failed" && submission.fulfillment_error && (
                      <Alert className="mt-3 border-red-200 bg-red-50">
                        <AlertCircle className="h-4 w-4 text-red-600" />
                        <AlertDescription className="text-red-700 text-xs">
                          <strong>Fulfillment error:</strong> {submission.fulfillment_error}
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
