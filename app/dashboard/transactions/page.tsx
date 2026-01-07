"use client"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { TrendingUp, TrendingDown, DollarSign, Loader2 } from "lucide-react"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/hooks/use-auth"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

// Safe format currency helper
const formatAmount = (amount: number | null | undefined): string => {
  if (amount == null) return "0.00"
  return amount.toFixed(2)
}

interface TransactionStats {
  totalTransactions: number
  todayIncome: number
  todayExpenses: number
  todayRefunds: number
}

interface Transaction {
  id: string
  created_at: string
  type: "credit" | "debit" | "refund"
  description: string
  amount: number
  balance_before: number
  balance_after: number
  status: "completed" | "pending" | "failed"
  order_id?: string
}

export default function TransactionsPage() {
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()
  const [stats, setStats] = useState<TransactionStats>({
    totalTransactions: 0,
    todayIncome: 0,
    todayExpenses: 0,
    todayRefunds: 0,
  })
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({
    type: "all",
    source: "all",
    dateRange: "all",
  })
  const [page, setPage] = useState(1)
  const pageSize = 10

  // Auth protection
  useEffect(() => {
    if (!authLoading && !user) {
      console.log("[TRANSACTIONS] User not authenticated, redirecting to login")
      router.push("/auth/login")
    }
  }, [user, authLoading, router])

  useEffect(() => {
    if (user) {
      fetchTransactionData()
    }
  }, [filters, page, user])

  const fetchTransactionData = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return

      // Fetch stats
      const statsResponse = await fetch("/api/transactions/stats", {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })
      if (statsResponse.ok) {
        const statsData = await statsResponse.json()
        setStats(statsData)
      }

      // Fetch transactions
      const queryParams = new URLSearchParams()
      queryParams.append("page", page.toString())
      queryParams.append("limit", pageSize.toString())
      if (filters.type !== "all") queryParams.append("type", filters.type)
      if (filters.dateRange !== "all") queryParams.append("dateRange", filters.dateRange)

      const txnResponse = await fetch(`/api/transactions/list?${queryParams.toString()}`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })
      if (txnResponse.ok) {
        const txnData = await txnResponse.json()
        setTransactions(txnData.transactions || [])
      }
    } catch (error) {
      console.error("Error fetching transaction data:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to load transaction data"
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-screen">
          <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="space-y-6 px-2 sm:px-4">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">My Transactions</h1>
          <p className="text-sm sm:text-base text-gray-600 mt-1">Track and manage your financial activities</p>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Transactions</CardTitle>
              <DollarSign className="h-4 w-4 text-blue-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.totalTransactions.toLocaleString()}</div>
              <p className="text-xs text-gray-600">All time</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Today's Income</CardTitle>
              <TrendingUp className="h-4 w-4 text-green-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">GHS {formatAmount(stats.todayIncome)}</div>
              <p className="text-xs text-gray-600">Credits</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Today's Expenses</CardTitle>
              <TrendingDown className="h-4 w-4 text-red-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">GHS {formatAmount(stats.todayExpenses)}</div>
              <p className="text-xs text-gray-600">Debits</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Today's Refunds</CardTitle>
              <DollarSign className="h-4 w-4 text-orange-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">GHS {formatAmount(stats.todayRefunds)}</div>
              <p className="text-xs text-gray-600">Refunded</p>
            </CardContent>
          </Card>
        </div>

        {/* Filters Card */}
        <Card>
          <CardHeader>
            <CardTitle>Filters</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label htmlFor="type" className="text-sm font-medium text-gray-700">Transaction Type</label>
                <select 
                  id="type"
                  value={filters.type}
                  onChange={(e) => { setFilters({ ...filters, type: e.target.value }); setPage(1); }}
                  className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-md"
                >
                  <option value="all">All Types</option>
                  <option value="credit">Credit</option>
                  <option value="debit">Debit</option>
                  <option value="refund">Refund</option>
                </select>
              </div>
              <div>
                <label htmlFor="dateRange" className="text-sm font-medium text-gray-700">Date Range</label>
                <select 
                  id="dateRange"
                  value={filters.dateRange}
                  onChange={(e) => { setFilters({ ...filters, dateRange: e.target.value }); setPage(1); }}
                  className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-md"
                >
                  <option value="all">All Time</option>
                  <option value="today">Today</option>
                  <option value="week">This Week</option>
                  <option value="month">This Month</option>
                  <option value="3months">Last 3 Months</option>
                </select>
              </div>
              <div>
                <Button 
                  onClick={() => { setFilters({ type: "all", source: "all", dateRange: "all" }); setPage(1); }}
                  variant="outline"
                  className="w-full mt-6"
                >
                  Clear Filters
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Transactions List */}
        <Card>
          <CardHeader>
            <CardTitle>Transactions List</CardTitle>
            <CardDescription>Your financial transaction history</CardDescription>
          </CardHeader>
          <CardContent>
            {transactions.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                No transactions found
              </div>
            ) : (
              <>
                {/* Mobile Card View */}
                <div className="md:hidden space-y-3">
                  {transactions.map((txn) => (
                    <div key={txn.id} className="border rounded-lg p-4 bg-white shadow-sm">
                      {/* Header: Date + Status */}
                      <div className="flex justify-between items-start mb-3">
                        <div>
                          <p className="text-xs text-gray-500">
                            {new Date(txn.created_at).toLocaleDateString()}
                          </p>
                          <p className="text-sm text-gray-700 mt-1 line-clamp-1">{txn.description}</p>
                        </div>
                        <Badge className={
                          txn.status === "completed" ? "bg-green-100 text-green-800" :
                          txn.status === "pending" ? "bg-yellow-100 text-yellow-800" :
                          "bg-red-100 text-red-800"
                        }>
                          {txn.status.charAt(0).toUpperCase() + txn.status.slice(1)}
                        </Badge>
                      </div>
                      
                      {/* Amount + Type */}
                      <div className="flex justify-between items-center mb-3">
                        <Badge className={
                          txn.type === "credit" ? "bg-green-100 text-green-800" :
                          txn.type === "debit" ? "bg-red-100 text-red-800" :
                          "bg-orange-100 text-orange-800"
                        }>
                          {txn.type.charAt(0).toUpperCase() + txn.type.slice(1)}
                        </Badge>
                        <span className={`text-lg font-bold ${
                          txn.type === "credit" ? "text-green-600" : "text-red-600"
                        }`}>
                          {txn.type === "credit" ? "+" : "-"}GHS {formatAmount(txn.amount)}
                        </span>
                      </div>
                      
                      {/* Balance Info */}
                      <div className="grid grid-cols-2 gap-2 text-xs border-t pt-3">
                        <div>
                          <span className="text-gray-500">Before:</span>
                          <span className="ml-1 font-medium">GHS {formatAmount(txn.balance_before)}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">After:</span>
                          <span className="ml-1 font-semibold">GHS {formatAmount(txn.balance_after)}</span>
                        </div>
                      </div>
                      
                      {/* Order ID + Action */}
                      <div className="flex justify-between items-center mt-3 pt-3 border-t">
                        <span className="text-xs text-gray-500">
                          {txn.order_id ? `#${txn.order_id.slice(0, 8)}...` : "No order"}
                        </span>
                        <Button size="sm" variant="outline">View</Button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Desktop Table View */}
                <div className="hidden md:block overflow-x-auto rounded-md border border-gray-100">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr>
                        <th className="px-4 py-3 text-left font-semibold text-gray-900">Date</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-900">Type</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-900">Source</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-900">Amount</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-900">Balance Before</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-900">Balance After</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-900">Status</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-900">Order ID</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-900">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {transactions.map((txn) => (
                        <tr key={txn.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3">{new Date(txn.created_at).toLocaleDateString()}</td>
                          <td className="px-4 py-3">
                            <Badge className={
                              txn.type === "credit" ? "bg-green-100 text-green-800" :
                              txn.type === "debit" ? "bg-red-100 text-red-800" :
                              "bg-orange-100 text-orange-800"
                            }>
                              {txn.type.charAt(0).toUpperCase() + txn.type.slice(1)}
                            </Badge>
                          </td>
                          <td className="px-4 py-3">{txn.description}</td>
                          <td className={`px-4 py-3 font-semibold ${
                            txn.type === "credit" ? "text-green-600" : "text-red-600"
                          }`}>
                            {txn.type === "credit" ? "+" : "-"}GHS {formatAmount(txn.amount)}
                          </td>
                          <td className="px-4 py-3">GHS {formatAmount(txn.balance_before)}</td>
                          <td className="px-4 py-3 font-semibold">GHS {formatAmount(txn.balance_after)}</td>
                          <td className="px-4 py-3">
                            <Badge className={
                              txn.status === "completed" ? "bg-green-100 text-green-800" :
                              txn.status === "pending" ? "bg-yellow-100 text-yellow-800" :
                              "bg-red-100 text-red-800"
                            }>
                              {txn.status.charAt(0).toUpperCase() + txn.status.slice(1)}
                            </Badge>
                          </td>
                          <td className="px-4 py-3">{txn.order_id || "—"}</td>
                          <td className="px-4 py-3">
                            <Button size="sm" variant="outline">View</Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            
            {/* Pagination */}
            <div className="mt-4 flex flex-col sm:flex-row justify-between items-center gap-3">
              <p className="text-sm text-gray-600">Showing {transactions.length} transaction(s)</p>
              <div className="flex gap-2">
                <Button 
                  variant="outline" 
                  onClick={() => setPage(page - 1)}
                  disabled={page === 1}
                  size="sm"
                  className="px-4"
                >
                  Previous
                </Button>
                <Button 
                  variant="outline"
                  onClick={() => setPage(page + 1)}
                  disabled={transactions.length < pageSize}
                  size="sm"
                  className="px-4"
                >
                  Next
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
