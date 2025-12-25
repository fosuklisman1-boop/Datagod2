"use client"

import { useState, useEffect, useCallback } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Search, ArrowUpCircle, ArrowDownCircle, Clock, XCircle, RefreshCw, Download, ChevronLeft, ChevronRight, TrendingUp, TrendingDown, AlertTriangle } from "lucide-react"
import { toast } from "sonner"

// Format currency helper
const formatCurrency = (amount: number) => `GHS ${amount.toFixed(2)}`

interface Transaction {
  id: string
  user_id: string
  type: "credit" | "debit"
  amount: number
  source: string
  description: string | null
  reference: string | null
  status: string
  created_at: string
  user_email: string
  user_first_name: string | null
  user_last_name: string | null
  user_phone: string | null
}

interface Stats {
  totalCredits: number
  totalDebits: number
  netFlow: number
  pendingCount: number
  failedCount: number
  totalTransactions: number
}

export default function AdminTransactionsPage() {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)

  // Filters
  const [search, setSearch] = useState("")
  const [typeFilter, setTypeFilter] = useState("all")
  const [sourceFilter, setSourceFilter] = useState("all")
  const [statusFilter, setStatusFilter] = useState("all")
  const [startDate, setStartDate] = useState("")
  const [endDate, setEndDate] = useState("")

  // Pagination
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [totalCount, setTotalCount] = useState(0)
  const limit = 20

  const fetchTransactions = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: limit.toString(),
      })

      if (search) params.append("search", search)
      if (typeFilter !== "all") params.append("type", typeFilter)
      if (sourceFilter !== "all") params.append("source", sourceFilter)
      if (statusFilter !== "all") params.append("status", statusFilter)
      if (startDate) params.append("startDate", startDate)
      if (endDate) params.append("endDate", endDate)

      const response = await fetch(`/api/admin/transactions?${params}`)
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to fetch transactions")
      }

      setTransactions(data.transactions)
      setStats(data.stats)
      setTotalPages(data.pagination.totalPages)
      setTotalCount(data.pagination.totalCount)
    } catch (error) {
      console.error("Error fetching transactions:", error)
      toast.error(error instanceof Error ? error.message : "Failed to fetch transactions")
    } finally {
      setLoading(false)
    }
  }, [page, search, typeFilter, sourceFilter, statusFilter, startDate, endDate])

  useEffect(() => {
    fetchTransactions()
  }, [fetchTransactions])

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1)
  }, [search, typeFilter, sourceFilter, statusFilter, startDate, endDate])

  const handleExport = async () => {
    setExporting(true)
    try {
      const params = new URLSearchParams()
      if (search) params.append("search", search)
      if (typeFilter !== "all") params.append("type", typeFilter)
      if (sourceFilter !== "all") params.append("source", sourceFilter)
      if (statusFilter !== "all") params.append("status", statusFilter)
      if (startDate) params.append("startDate", startDate)
      if (endDate) params.append("endDate", endDate)
      params.append("limit", "10000") // Get all matching transactions

      const response = await fetch(`/api/admin/transactions?${params}`)
      const data = await response.json()

      if (!response.ok) throw new Error(data.error)

      // Create CSV
      const headers = ["Date", "User Email", "User Name", "Type", "Amount", "Source", "Description", "Reference", "Status"]
      const rows = data.transactions.map((t: Transaction) => [
        new Date(t.created_at).toLocaleString(),
        t.user_email,
        `${t.user_first_name || ""} ${t.user_last_name || ""}`.trim() || "N/A",
        t.type,
        t.amount,
        t.source,
        t.description || "",
        t.reference || "",
        t.status,
      ])

      const csv = [headers, ...rows].map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n")
      
      const blob = new Blob([csv], { type: "text/csv" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `transactions-${new Date().toISOString().split("T")[0]}.csv`
      a.click()
      URL.revokeObjectURL(url)

      toast.success(`Exported ${data.transactions.length} transactions`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to export transactions")
    } finally {
      setExporting(false)
    }
  }

  const getStatusBadge = (status: string) => {
    switch (status.toLowerCase()) {
      case "completed":
        return <Badge className="bg-green-500 hover:bg-green-600">Completed</Badge>
      case "pending":
        return <Badge className="bg-yellow-500 hover:bg-yellow-600">Pending</Badge>
      case "failed":
        return <Badge className="bg-red-500 hover:bg-red-600">Failed</Badge>
      default:
        return <Badge variant="secondary">{status}</Badge>
    }
  }

  const getTypeBadge = (type: string) => {
    return type === "credit" 
      ? <Badge className="bg-green-100 text-green-800 hover:bg-green-200"><ArrowUpCircle className="w-3 h-3 mr-1" />Credit</Badge>
      : <Badge className="bg-red-100 text-red-800 hover:bg-red-200"><ArrowDownCircle className="w-3 h-3 mr-1" />Debit</Badge>
  }

  const getSourceLabel = (source: string) => {
    const sourceMap: { [key: string]: string } = {
      paystack: "Paystack",
      admin_credit: "Admin Credit",
      admin_debit: "Admin Debit",
      data_purchase: "Data Purchase",
      bulk_order: "Bulk Order",
      shop_purchase: "Shop Purchase",
      shop_profit: "Shop Profit",
      referral_bonus: "Referral Bonus",
      refund: "Refund",
    }
    return sourceMap[source] || source
  }

  const clearFilters = () => {
    setSearch("")
    setTypeFilter("all")
    setSourceFilter("all")
    setStatusFilter("all")
    setStartDate("")
    setEndDate("")
  }

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">All Transactions</h1>
          <p className="text-muted-foreground">View and manage all user transactions</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => fetchTransactions()} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button onClick={handleExport} disabled={exporting}>
            <Download className="w-4 h-4 mr-2" />
            {exporting ? "Exporting..." : "Export CSV"}
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid gap-4 md:grid-cols-5">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Credits</CardTitle>
              <TrendingUp className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">{formatCurrency(stats.totalCredits)}</div>
              <p className="text-xs text-muted-foreground">Money in</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Debits</CardTitle>
              <TrendingDown className="h-4 w-4 text-red-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-600">{formatCurrency(stats.totalDebits)}</div>
              <p className="text-xs text-muted-foreground">Money out</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Net Flow</CardTitle>
              {stats.netFlow >= 0 ? (
                <ArrowUpCircle className="h-4 w-4 text-green-500" />
              ) : (
                <ArrowDownCircle className="h-4 w-4 text-red-500" />
              )}
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold ${stats.netFlow >= 0 ? "text-green-600" : "text-red-600"}`}>
                {formatCurrency(Math.abs(stats.netFlow))}
              </div>
              <p className="text-xs text-muted-foreground">{stats.netFlow >= 0 ? "Net positive" : "Net negative"}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending</CardTitle>
              <Clock className="h-4 w-4 text-yellow-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-yellow-600">{stats.pendingCount}</div>
              <p className="text-xs text-muted-foreground">Awaiting completion</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Failed</CardTitle>
              <AlertTriangle className="h-4 w-4 text-red-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-600">{stats.failedCount}</div>
              <p className="text-xs text-muted-foreground">Failed transactions</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>Search and filter transactions</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-6">
            <div className="lg:col-span-2">
              <Label htmlFor="search">Search</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="search"
                  placeholder="Email, name, phone, reference..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="type">Type</Label>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger id="type">
                  <SelectValue placeholder="All types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="credit">Credit</SelectItem>
                  <SelectItem value="debit">Debit</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="source">Source</Label>
              <Select value={sourceFilter} onValueChange={setSourceFilter}>
                <SelectTrigger id="source">
                  <SelectValue placeholder="All sources" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Sources</SelectItem>
                  <SelectItem value="paystack">Paystack</SelectItem>
                  <SelectItem value="admin_credit">Admin Credit</SelectItem>
                  <SelectItem value="admin_debit">Admin Debit</SelectItem>
                  <SelectItem value="data_purchase">Data Purchase</SelectItem>
                  <SelectItem value="bulk_order">Bulk Order</SelectItem>
                  <SelectItem value="shop_purchase">Shop Purchase</SelectItem>
                  <SelectItem value="shop_profit">Shop Profit</SelectItem>
                  <SelectItem value="referral_bonus">Referral Bonus</SelectItem>
                  <SelectItem value="refund">Refund</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="status">Status</Label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger id="status">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-end">
              <Button variant="ghost" onClick={clearFilters} className="w-full">
                Clear Filters
              </Button>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 mt-4">
            <div>
              <Label htmlFor="startDate">Start Date</Label>
              <Input
                id="startDate"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="endDate">End Date</Label>
              <Input
                id="endDate"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Transactions Table */}
      <Card>
        <CardHeader>
          <CardTitle>
            Transactions
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              ({totalCount} total)
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center items-center h-64">
              <RefreshCw className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          ) : transactions.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
              <XCircle className="w-12 h-12 mb-4" />
              <p>No transactions found</p>
              <p className="text-sm">Try adjusting your filters</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>User</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Reference</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {transactions.map((transaction) => (
                      <TableRow key={transaction.id}>
                        <TableCell className="whitespace-nowrap">
                          {new Date(transaction.created_at).toLocaleString()}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium">{transaction.user_email}</span>
                            <span className="text-sm text-muted-foreground">
                              {`${transaction.user_first_name || ""} ${transaction.user_last_name || ""}`.trim() || "No name"}
                            </span>
                            {transaction.user_phone && (
                              <span className="text-xs text-muted-foreground">{transaction.user_phone}</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>{getTypeBadge(transaction.type)}</TableCell>
                        <TableCell className={`font-medium ${transaction.type === "credit" ? "text-green-600" : "text-red-600"}`}>
                          {transaction.type === "credit" ? "+" : "-"}{formatCurrency(transaction.amount)}
                        </TableCell>
                        <TableCell>
                          <span className="text-sm">{getSourceLabel(transaction.source)}</span>
                        </TableCell>
                        <TableCell className="max-w-[200px] truncate" title={transaction.description || ""}>
                          {transaction.description || "-"}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {transaction.reference || "-"}
                        </TableCell>
                        <TableCell>{getStatusBadge(transaction.status)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between mt-4">
                <p className="text-sm text-muted-foreground">
                  Showing {(page - 1) * limit + 1} to {Math.min(page * limit, totalCount)} of {totalCount} transactions
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                  >
                    <ChevronLeft className="w-4 h-4" />
                    Previous
                  </Button>
                  <span className="text-sm">
                    Page {page} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                  >
                    Next
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
