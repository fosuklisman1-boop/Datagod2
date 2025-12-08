"use client"

import { useEffect, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Settings, Copy, Check, Search, Filter } from "lucide-react"
import { useAdminProtected } from "@/hooks/use-admin"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"

interface AFASubmission {
  id: string
  user_id: string
  phone_number: string
  amount: number
  status: "pending" | "processing" | "completed" | "cancelled"
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
  const [copiedId, setCopiedId] = useState<string | null>(null)

  useEffect(() => {
    if (isAdmin && !adminLoading) {
      loadSettings()
      loadSubmissions()
    }
  }, [isAdmin, adminLoading])

  useEffect(() => {
    filterSubmissions()
  }, [submissions, searchTerm, filterStatus])

  const loadSettings = async () => {
    try {
      // Load AFA price from localStorage or use default
      const stored = localStorage.getItem("afa_price")
      if (stored) {
        setSettings({ price: parseFloat(stored) })
      }
    } catch (error) {
      console.error("Error loading settings:", error)
    }
  }

  const loadSubmissions = async () => {
    try {
      setLoading(true)
      const token = localStorage.getItem("sb-token")
      if (!token) {
        toast.error("Authentication required")
        return
      }

      const response = await fetch("/api/admin/afa-registrations", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (!response.ok) {
        throw new Error("Failed to fetch submissions")
      }

      const data = await response.json()
      setSubmissions(data.submissions || [])
    } catch (error) {
      console.error("Error loading submissions:", error)
      toast.error("Failed to load AFA submissions")
    } finally {
      setLoading(false)
    }
  }

  const filterSubmissions = () => {
    let filtered = submissions

    // Search filter
    if (searchTerm) {
      const term = searchTerm.toLowerCase()
      filtered = filtered.filter(
        (sub) =>
          sub.user_email?.toLowerCase().includes(term) ||
          sub.phone_number?.includes(term) ||
          sub.order_code?.toLowerCase().includes(term) ||
          sub.transaction_code?.toLowerCase().includes(term)
      )
    }

    // Status filter
    if (filterStatus !== "all") {
      filtered = filtered.filter((sub) => sub.status === filterStatus)
    }

    setFilteredSubmissions(filtered)
  }

  const handleSavePrice = async () => {
    try {
      setSavingPrice(true)
      localStorage.setItem("afa_price", settings.price.toString())
      toast.success("AFA price updated successfully")
    } catch (error) {
      console.error("Error saving price:", error)
      toast.error("Failed to save AFA price")
    } finally {
      setSavingPrice(false)
    }
  }

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    toast.success("Copied to clipboard")
    setTimeout(() => setCopiedId(null), 2000)
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed":
        return "bg-green-100 text-green-800"
      case "processing":
        return "bg-blue-100 text-blue-800"
      case "pending":
        return "bg-yellow-100 text-yellow-800"
      case "cancelled":
        return "bg-red-100 text-red-800"
      default:
        return "bg-gray-100 text-gray-800"
    }
  }

  const stats = {
    total: submissions.length,
    pending: submissions.filter((s) => s.status === "pending").length,
    processing: submissions.filter((s) => s.status === "processing").length,
    completed: submissions.filter((s) => s.status === "completed").length,
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
          <h1 className="text-4xl font-bold bg-gradient-to-r from-cyan-600 via-blue-600 to-purple-600 bg-clip-text text-transparent">
            AFA Management
          </h1>
          <p className="text-gray-500 mt-1 font-medium">Configure pricing and manage AFA registrations</p>
        </div>

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
            <p className="text-xs text-gray-500 mt-2">Current AFA registration cost: GHS {settings.price.toFixed(2)}</p>
          </CardContent>
        </Card>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 sm:gap-4">
          <Card className="bg-gradient-to-br from-blue-50/60 to-cyan-50/40 backdrop-blur-xl border border-blue-200/40">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-gray-900">Total Submissions</CardTitle>
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

          <Card className="bg-gradient-to-br from-blue-50/60 to-indigo-50/40 backdrop-blur-xl border border-blue-200/40">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-gray-900">Processing</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-600">{stats.processing}</div>
            </CardContent>
          </Card>

          <Card className="bg-gradient-to-br from-green-50/60 to-emerald-50/40 backdrop-blur-xl border border-green-200/40">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-gray-900">Completed</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">{stats.completed}</div>
            </CardContent>
          </Card>
        </div>

        {/* Submissions List */}
        <Card className="border-l-4 border-l-blue-500 bg-gradient-to-br from-blue-50/60 to-cyan-50/40 backdrop-blur-xl border border-blue-200/40">
          <CardHeader>
            <CardTitle>AFA Submissions</CardTitle>
            <CardDescription>View and manage all AFA registration submissions</CardDescription>
          </CardHeader>
          <CardContent>
            {/* Search and Filter */}
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
                className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-cyan-500"
              >
                <option value="all">All Status</option>
                <option value="pending">Pending</option>
                <option value="processing">Processing</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>

            {/* Table */}
            {loading ? (
              <div className="text-center py-8 text-gray-500">Loading submissions...</div>
            ) : filteredSubmissions.length === 0 ? (
              <div className="text-center py-8 text-gray-500">No submissions found</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-gray-200">
                    <tr>
                      <th className="text-left py-3 px-4 font-semibold text-gray-900">Email</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-900">Phone</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-900">Order Code</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-900">Amount</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-900">Status</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-900">Date</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-900">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSubmissions.map((submission) => (
                      <tr key={submission.id} className="border-b border-gray-100 hover:bg-white/50">
                        <td className="py-3 px-4 text-gray-900">{submission.user_email}</td>
                        <td className="py-3 px-4 text-gray-900">{submission.phone_number}</td>
                        <td className="py-3 px-4">
                          <button
                            onClick={() => copyToClipboard(submission.order_code, `order-${submission.id}`)}
                            className="flex items-center gap-2 text-cyan-600 hover:text-cyan-700 font-mono text-xs"
                          >
                            {submission.order_code}
                            {copiedId === `order-${submission.id}` ? (
                              <Check className="h-3 w-3" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                          </button>
                        </td>
                        <td className="py-3 px-4 font-semibold text-gray-900">GHS {submission.amount.toFixed(2)}</td>
                        <td className="py-3 px-4">
                          <Badge className={getStatusColor(submission.status)}>{submission.status}</Badge>
                        </td>
                        <td className="py-3 px-4 text-gray-600 text-xs">
                          {new Date(submission.created_at).toLocaleDateString()}
                        </td>
                        <td className="py-3 px-4">
                          <button
                            onClick={() => copyToClipboard(JSON.stringify(submission, null, 2), `full-${submission.id}`)}
                            className="flex items-center gap-1 text-gray-600 hover:text-gray-900 text-xs"
                          >
                            {copiedId === `full-${submission.id}` ? (
                              <Check className="h-3 w-3" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                            Copy
                          </button>
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
