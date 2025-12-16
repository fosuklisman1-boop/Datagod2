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
      <div className="space-y-6">
        {/* Page Header */}
        <div>
          <h1 className="text-3xl font-bold text-gray-900">My Transactions</h1>
          <p className="text-gray-600 mt-1">Track and manage your financial activities</p>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
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
              <div className="text-2xl font-bold">GHS {stats.todayIncome.toFixed(2)}</div>
              <p className="text-xs text-gray-600">Credits</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Today's Expenses</CardTitle>
              <TrendingDown className="h-4 w-4 text-red-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">GHS {stats.todayExpenses.toFixed(2)}</div>
              <p className="text-xs text-gray-600">Debits</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Today's Refunds</CardTitle>
              <DollarSign className="h-4 w-4 text-orange-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">GHS {stats.todayRefunds.toFixed(2)}</div>
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

        {/* Transactions Table */}
        <Card>
          <CardHeader>
            <CardTitle>Transactions List</CardTitle>
            <CardDescription>Your financial transaction history</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Date</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Type</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Source</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Amount</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Balance Before</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Balance After</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Status</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Order ID</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {transactions.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-6 py-4 text-center text-sm text-gray-500">
                        No transactions found
                      </td>
                    </tr>
                  ) : (
                    transactions.map((txn) => (
                      <tr key={txn.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 text-sm">{new Date(txn.created_at).toLocaleDateString()}</td>
                        <td className="px-6 py-4 text-sm">
                          <Badge className={
                            txn.type === "credit" ? "bg-green-100 text-green-800" :
                            txn.type === "debit" ? "bg-red-100 text-red-800" :
                            "bg-orange-100 text-orange-800"
                          }>
                            {txn.type.charAt(0).toUpperCase() + txn.type.slice(1)}
                          </Badge>
                        </td>
                        <td className="px-6 py-4 text-sm">{txn.description}</td>
                        <td className={`px-6 py-4 text-sm font-semibold ${
                          txn.type === "credit" ? "text-green-600" : "text-red-600"
                        }`}>
                          {txn.type === "credit" ? "+" : "-"}GHS {txn.amount.toFixed(2)}
                        </td>
                        <td className="px-6 py-4 text-sm">GHS {txn.balance_before.toFixed(2)}</td>
                        <td className="px-6 py-4 text-sm font-semibold">GHS {txn.balance_after.toFixed(2)}</td>
                        <td className="px-6 py-4 text-sm">
                          <Badge className={
                            txn.status === "completed" ? "bg-green-100 text-green-800" :
                            txn.status === "pending" ? "bg-yellow-100 text-yellow-800" :
                            "bg-red-100 text-red-800"
                          }>
                            {txn.status.charAt(0).toUpperCase() + txn.status.slice(1)}
                          </Badge>
                        </td>
                        <td className="px-6 py-4 text-sm">{txn.order_id || "—"}</td>
                        <td className="px-6 py-4 text-sm">
                          <Button size="sm" variant="outline">View</Button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex justify-between items-center">
              <p className="text-sm text-gray-600">Showing {transactions.length} transaction(s)</p>
              <div className="flex gap-2">
                <Button 
                  variant="outline" 
                  onClick={() => setPage(page - 1)}
                  disabled={page === 1}
                >
                  Previous
                </Button>
                <Button 
                  variant="outline"
                  onClick={() => setPage(page + 1)}
                  disabled={transactions.length < pageSize}
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
