"use client"

import type { ChangeEvent } from "react"
import { useState, useEffect, useCallback } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
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
import { Search, Clock, CheckCircle, XCircle, AlertTriangle, RefreshCw, ChevronLeft, ChevronRight, Wallet, ShoppingCart, TrendingUp } from "lucide-react"
import { toast } from "sonner"

// Safe format currency helper
const formatCurrency = (amount: number | null | undefined) => {
  if (amount == null) return "GHS 0.00"
  return `GHS ${amount.toFixed(2)}`
}

interface PaymentAttempt {
  id: string
  user_id: string
  reference: string
  amount: number | null
  fee: number | null
  email: string
  status: "pending" | "completed" | "failed" | "abandoned"
  payment_type: "wallet_topup" | "shop_order"
  shop_id: string | null
  order_id: string | null
  gateway_response: string | null
  paystack_transaction_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  user_email: string
  user_first_name: string | null
  user_last_name: string | null
  user_phone: string | null
}

interface Stats {
  total: number
  pending: number
  completed: number
  failed: number
  abandoned: number
  totalAmount: number
  completedAmount: number
  walletTopups: number
  shopOrders: number
}

const defaultStats: Stats = {
  total: 0,
  pending: 0,
  completed: 0,
  failed: 0,
  abandoned: 0,
  totalAmount: 0,
  completedAmount: 0,
  walletTopups: 0,
  shopOrders: 0,
}

export default function PaymentAttemptsPage() {
  const [attempts, setAttempts] = useState<PaymentAttempt[]>([])
  const [stats, setStats] = useState<Stats>(defaultStats)
  const [loading, setLoading] = useState(true)

  // Filters
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [typeFilter, setTypeFilter] = useState("all")
  const [startDate, setStartDate] = useState("")
  const [endDate, setEndDate] = useState("")

  // Pagination
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [totalCount, setTotalCount] = useState(0)
  const limit = 20

  const fetchAttempts = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: limit.toString(),
      })

      if (search) params.append("search", search)
      if (statusFilter !== "all") params.append("status", statusFilter)
      if (typeFilter !== "all") params.append("paymentType", typeFilter)
      if (startDate) params.append("startDate", startDate)
      if (endDate) params.append("endDate", endDate)

      const response = await fetch(`/api/admin/payment-attempts?${params}`)
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to fetch payment attempts")
      }

      setAttempts(data.attempts || [])
      setStats({
        total: data.stats?.total ?? 0,
        pending: data.stats?.pending ?? 0,
        completed: data.stats?.completed ?? 0,
        failed: data.stats?.failed ?? 0,
        abandoned: data.stats?.abandoned ?? 0,
        totalAmount: data.stats?.totalAmount ?? 0,
        completedAmount: data.stats?.completedAmount ?? 0,
        walletTopups: data.stats?.walletTopups ?? 0,
        shopOrders: data.stats?.shopOrders ?? 0,
      })
      setTotalPages(data.pagination?.totalPages || 1)
      setTotalCount(data.pagination?.totalCount || 0)
    } catch (error) {
      console.error("Error fetching payment attempts:", error)
      toast.error(error instanceof Error ? error.message : "Failed to fetch payment attempts")
    } finally {
      setLoading(false)
    }
  }, [page, search, statusFilter, typeFilter, startDate, endDate])

  useEffect(() => {
    fetchAttempts()
  }, [fetchAttempts])

  useEffect(() => {
    setPage(1)
  }, [search, statusFilter, typeFilter, startDate, endDate])

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "completed":
        return <Badge className="bg-green-500 hover:bg-green-600"><CheckCircle className="w-3 h-3 mr-1" />Completed</Badge>
      case "pending":
        return <Badge className="bg-yellow-500 hover:bg-yellow-600"><Clock className="w-3 h-3 mr-1" />Pending</Badge>
      case "failed":
        return <Badge className="bg-red-500 hover:bg-red-600"><XCircle className="w-3 h-3 mr-1" />Failed</Badge>
      case "abandoned":
        return <Badge className="bg-gray-500 hover:bg-gray-600"><AlertTriangle className="w-3 h-3 mr-1" />Abandoned</Badge>
      default:
        return <Badge variant="secondary">{status}</Badge>
    }
  }

  const getTypeBadge = (type: string) => {
    return type === "wallet_topup"
      ? <Badge variant="outline" className="border-blue-500 text-blue-600"><Wallet className="w-3 h-3 mr-1" />Wallet</Badge>
      : <Badge variant="outline" className="border-purple-500 text-purple-600"><ShoppingCart className="w-3 h-3 mr-1" />Shop Order</Badge>
  }

  const clearFilters = () => {
    setSearch("")
    setStatusFilter("all")
    setTypeFilter("all")
    setStartDate("")
    setEndDate("")
  }

  const conversionRate = stats.total > 0 ? ((stats.completed / stats.total) * 100).toFixed(1) : "0.0"

  return (
    <DashboardLayout>
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">Payment Attempts</h1>
          <p className="text-muted-foreground">Track all payment attempts including pending and abandoned</p>
        </div>
        <Button variant="outline" onClick={() => fetchAttempts()} disabled={loading}>
          <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Attempts</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.total}</div>
            <p className="text-xs text-muted-foreground">{formatCurrency(stats.totalAmount)}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Completed</CardTitle>
            <CheckCircle className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{stats.completed}</div>
            <p className="text-xs text-muted-foreground">{formatCurrency(stats.completedAmount)}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pending</CardTitle>
            <Clock className="h-4 w-4 text-yellow-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">{stats.pending}</div>
            <p className="text-xs text-muted-foreground">Awaiting payment</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Failed</CardTitle>
            <XCircle className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{stats.failed}</div>
            <p className="text-xs text-muted-foreground">Payment failed</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Abandoned</CardTitle>
            <AlertTriangle className="h-4 w-4 text-gray-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-gray-600">{stats.abandoned}</div>
            <p className="text-xs text-muted-foreground">Never completed</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Conversion</CardTitle>
            <TrendingUp className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">{conversionRate}%</div>
            <p className="text-xs text-muted-foreground">Success rate</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
            <div className="lg:col-span-2">
              <Label htmlFor="search">Search</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="search"
                  placeholder="Email or reference..."
                  value={search}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="status">Status</Label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger id="status">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="abandoned">Abandoned</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="type">Type</Label>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger id="type">
                  <SelectValue placeholder="All types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="wallet_topup">Wallet Top-up</SelectItem>
                  <SelectItem value="shop_order">Shop Order</SelectItem>
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

      {/* Table */}
      <Card>
        <CardHeader>
          <CardTitle>
            Payment Attempts
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
          ) : attempts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
              <XCircle className="w-12 h-12 mb-4" />
              <p>No payment attempts found</p>
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
                      <TableHead>Status</TableHead>
                      <TableHead>Reference</TableHead>
                      <TableHead>Response</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {attempts.map((attempt) => (
                      <TableRow key={attempt.id}>
                        <TableCell className="whitespace-nowrap">
                          <div className="flex flex-col">
                            <span>{new Date(attempt.created_at).toLocaleDateString()}</span>
                            <span className="text-xs text-muted-foreground">
                              {new Date(attempt.created_at).toLocaleTimeString()}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium">{attempt.user_email}</span>
                            <span className="text-sm text-muted-foreground">
                              {`${attempt.user_first_name || ""} ${attempt.user_last_name || ""}`.trim() || "No name"}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>{getTypeBadge(attempt.payment_type)}</TableCell>
                        <TableCell className="font-medium">
                          {formatCurrency(attempt.amount)}
                          {attempt.fee && attempt.fee > 0 && (
                            <div className="text-xs text-muted-foreground">
                              Fee: {formatCurrency(attempt.fee)}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>{getStatusBadge(attempt.status)}</TableCell>
                        <TableCell className="font-mono text-xs max-w-[150px] truncate" title={attempt.reference}>
                          {attempt.reference}
                        </TableCell>
                        <TableCell className="max-w-[150px] truncate text-sm" title={attempt.gateway_response || ""}>
                          {attempt.gateway_response || "-"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between mt-4">
                <p className="text-sm text-muted-foreground">
                  Showing {(page - 1) * limit + 1} to {Math.min(page * limit, totalCount)} of {totalCount}
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
    </DashboardLayout>
  )
}
