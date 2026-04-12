"use client"

import { useEffect, useState, useCallback } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { useAdminProtected } from "@/hooks/use-admin"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { RefreshCw, Loader2, History, Search, ArrowRight, TrendingDown } from "lucide-react"

interface Withdrawal {
  id: string
  shop_id: string
  user_id: string
  amount: number
  fee_amount: number
  net_amount: number
  status: string
  withdrawal_method: string
  account_details: any
  reference_code: string
  rejection_reason?: string
  balance_before: number | null
  balance_after: number | null
  created_at: string
  updated_at: string
  user_shops?: { shop_name: string; shop_slug: string }
  current_available_balance?: number
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession()
  if (session?.access_token) return { Authorization: `Bearer ${session.access_token}` }
  return {}
}

const STATUS_COLORS: Record<string, string> = {
  pending:   "bg-yellow-100 text-yellow-800 border-yellow-200",
  approved:  "bg-blue-100 text-blue-800 border-blue-200",
  completed: "bg-green-100 text-green-800 border-green-200",
  rejected:  "bg-red-100 text-red-800 border-red-200",
  cancelled: "bg-gray-100 text-gray-700 border-gray-200",
}

const GHS = (n: number | null | undefined) =>
  n != null ? `GHS ${Number(n).toFixed(2)}` : "—"

export default function WithdrawalHistoryPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([])
  const [filtered, setFiltered] = useState<Withdrawal[]>([])
  const [loading, setLoading] = useState(false)
  const [statusFilter, setStatusFilter] = useState("all")
  const [search, setSearch] = useState("")

  const fetchWithdrawals = useCallback(async () => {
    setLoading(true)
    try {
      const headers = await getAuthHeaders()
      const res = await fetch("/api/admin/withdrawals/list?status=all", { headers })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Failed to fetch")
      }
      const data: Withdrawal[] = await res.json()
      setWithdrawals(data)
    } catch (err: any) {
      toast.error(err.message || "Failed to load withdrawal history")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!adminLoading && isAdmin) fetchWithdrawals()
  }, [isAdmin, adminLoading, fetchWithdrawals])

  // Apply filters
  useEffect(() => {
    let result = withdrawals
    if (statusFilter !== "all") result = result.filter(w => w.status === statusFilter)
    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter(w =>
        w.user_shops?.shop_name?.toLowerCase().includes(q) ||
        w.reference_code?.toLowerCase().includes(q) ||
        w.withdrawal_method?.toLowerCase().includes(q)
      )
    }
    setFiltered(result)
  }, [withdrawals, statusFilter, search])

  const stats = {
    total: withdrawals.length,
    pending: withdrawals.filter(w => w.status === "pending").length,
    approved: withdrawals.filter(w => w.status === "approved").length,
    completed: withdrawals.filter(w => w.status === "completed").length,
    rejected: withdrawals.filter(w => w.status === "rejected").length,
    totalAmount: withdrawals.reduce((s, w) => s + (w.amount || 0), 0),
  }

  if (adminLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="space-y-6 p-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <History className="w-6 h-6 text-blue-500" />
              Withdrawal History
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              All withdrawal requests from shop owners with balance snapshots.
            </p>
          </div>
          <Button variant="outline" onClick={fetchWithdrawals} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: "Total", value: stats.total, color: "text-gray-800" },
            { label: "Pending", value: stats.pending, color: "text-yellow-600" },
            { label: "Approved", value: stats.approved, color: "text-blue-600" },
            { label: "Completed", value: stats.completed, color: "text-green-600" },
            { label: "Rejected", value: stats.rejected, color: "text-red-600" },
            { label: "Total Value", value: `GHS ${stats.totalAmount.toFixed(2)}`, color: "text-gray-800" },
          ].map(s => (
            <Card key={s.label}>
              <CardContent className="pt-4 pb-3">
                <p className="text-xs text-gray-500">{s.label}</p>
                <p className={`text-lg font-bold ${s.color}`}>{s.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <Input
                  placeholder="Search by shop name or reference..."
                  className="pl-9"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              <div className="flex gap-2 flex-wrap">
                {["all", "pending", "approved", "completed", "rejected", "cancelled"].map(s => (
                  <Button
                    key={s}
                    size="sm"
                    variant={statusFilter === s ? "default" : "outline"}
                    onClick={() => setStatusFilter(s)}
                    className="capitalize"
                  >
                    {s}
                  </Button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Table */}
        <Card>
          <CardHeader>
            <CardTitle>Transactions</CardTitle>
            <CardDescription>
              Showing {filtered.length} of {withdrawals.length} withdrawals.
              Balance before/after reflects the shop&apos;s available profit at the time of each event.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-16 text-gray-500">
                <TrendingDown className="w-10 h-10 mx-auto mb-3 text-gray-300" />
                <p>No withdrawals found.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="pb-3 pr-4 font-medium text-gray-600">Shop</th>
                      <th className="pb-3 pr-4 font-medium text-gray-600">Reference</th>
                      <th className="pb-3 pr-4 font-medium text-gray-600">Amount</th>
                      <th className="pb-3 pr-4 font-medium text-gray-600">Method</th>
                      <th className="pb-3 pr-4 font-medium text-gray-600">Status</th>
                      <th className="pb-3 pr-4 font-medium text-gray-600">Balance Before</th>
                      <th className="pb-3 pr-4 font-medium text-gray-600">Balance After</th>
                      <th className="pb-3 font-medium text-gray-600">Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {filtered.map(w => {
                      const isPending = w.status === "pending"
                      return (
                        <tr key={w.id} className="hover:bg-gray-50">
                          {/* Shop */}
                          <td className="py-3 pr-4">
                            <p className="font-medium text-gray-900">
                              {w.user_shops?.shop_name || "Unknown Shop"}
                            </p>
                            {w.current_available_balance != null && (
                              <p className="text-xs text-gray-400">
                                Current: {GHS(w.current_available_balance)}
                              </p>
                            )}
                          </td>

                          {/* Reference */}
                          <td className="py-3 pr-4">
                            <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">
                              {w.reference_code}
                            </code>
                          </td>

                          {/* Amount */}
                          <td className="py-3 pr-4">
                            <p className="font-semibold text-gray-900">{GHS(w.amount)}</p>
                            {w.fee_amount > 0 && (
                              <p className="text-xs text-gray-400">
                                Fee: {GHS(w.fee_amount)} · Net: {GHS(w.net_amount)}
                              </p>
                            )}
                          </td>

                          {/* Method */}
                          <td className="py-3 pr-4 text-gray-600 capitalize text-xs">
                            {w.withdrawal_method?.replace(/_/g, " ") || "—"}
                          </td>

                          {/* Status */}
                          <td className="py-3 pr-4">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border capitalize ${STATUS_COLORS[w.status] || STATUS_COLORS.cancelled}`}>
                              {w.status}
                            </span>
                            {w.rejection_reason && (
                              <p className="text-xs text-red-500 mt-1 max-w-[160px] truncate" title={w.rejection_reason}>
                                {w.rejection_reason}
                              </p>
                            )}
                          </td>

                          {/* Balance Before */}
                          <td className="py-3 pr-4">
                            <span className="font-mono text-sm text-gray-700">
                              {GHS(w.balance_before)}
                            </span>
                          </td>

                          {/* Balance After */}
                          <td className="py-3 pr-4">
                            {isPending ? (
                              <span className="text-xs text-gray-400 italic">Pending approval</span>
                            ) : w.balance_after != null ? (
                              <span className="flex items-center gap-1.5">
                                <span className="font-mono text-sm text-gray-700">{GHS(w.balance_after)}</span>
                                {w.balance_before != null && (
                                  <span className={`text-xs font-medium ${w.balance_after < w.balance_before ? "text-red-500" : "text-green-600"}`}>
                                    ({w.balance_after < w.balance_before ? "-" : "+"}{GHS(Math.abs(w.balance_after - w.balance_before))})
                                  </span>
                                )}
                              </span>
                            ) : (
                              <span className="text-xs text-gray-400">—</span>
                            )}
                          </td>

                          {/* Date */}
                          <td className="py-3 text-xs text-gray-500">
                            {new Date(w.created_at).toLocaleDateString("en-GB", {
                              day: "2-digit", month: "short", year: "numeric"
                            })}
                            <br />
                            {new Date(w.created_at).toLocaleTimeString("en-GB", {
                              hour: "2-digit", minute: "2-digit"
                            })}
                          </td>
                        </tr>
                      )
                    })}
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
