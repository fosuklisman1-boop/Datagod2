"use client"

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
import { Search, Clock, XCircle, RefreshCw, Download, ChevronLeft, ChevronRight, TrendingUp, Wallet, CheckCircle, Banknote } from "lucide-react"
import { toast } from "sonner"

// Format currency helper
const formatCurrency = (amount: number | null | undefined) => {
  if (amount == null) return "GHS 0.00"
  return `GHS ${amount.toFixed(2)}`
}

interface ProfitRecord {
  id: string
  shop_id: string
  shop_order_id: string
  profit_amount: number
  profit_balance_before: number | null
  profit_balance_after: number | null
  status: string
  credited_at: string | null
  created_at: string
  shop_name: string
  shop_slug: string
  owner_email: string
  owner_first_name: string | null
  owner_last_name: string | null
  owner_phone: string | null
  order_reference: string | null
  order_network: string | null
  order_volume_gb: number | null
  order_total_price: number | null
  customer_name: string | null
  customer_phone: string | null
}

interface Stats {
  totalProfit: number
  pendingProfit: number
  creditedProfit: number
  withdrawnProfit: number
  pendingCount: number
  creditedCount: number
  withdrawnCount: number
  totalRecords: number
}

const defaultStats: Stats = {
  totalProfit: 0,
  pendingProfit: 0,
  creditedProfit: 0,
  withdrawnProfit: 0,
  pendingCount: 0,
  creditedCount: 0,
  withdrawnCount: 0,
  totalRecords: 0,
}

export default function AdminProfitsHistoryPage() {
  const [profits, setProfits] = useState<ProfitRecord[]>([])
  const [stats, setStats] = useState<Stats>(defaultStats)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)

  // Filters
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [startDate, setStartDate] = useState("")
  const [endDate, setEndDate] = useState("")

  // Pagination
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [totalCount, setTotalCount] = useState(0)
  const limit = 20

  const fetchProfits = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: limit.toString(),
      })

      if (search) params.append("search", search)
      if (statusFilter !== "all") params.append("status", statusFilter)
      if (startDate) params.append("startDate", startDate)
      if (endDate) params.append("endDate", endDate)

      const response = await fetch(`/api/admin/profits-history?${params}`)
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to fetch profits history")
      }

      setProfits(data.profits || [])
      setStats({
        totalProfit: data.stats?.totalProfit ?? 0,
        pendingProfit: data.stats?.pendingProfit ?? 0,
        creditedProfit: data.stats?.creditedProfit ?? 0,
        withdrawnProfit: data.stats?.withdrawnProfit ?? 0,
        pendingCount: data.stats?.pendingCount ?? 0,
        creditedCount: data.stats?.creditedCount ?? 0,
        withdrawnCount: data.stats?.withdrawnCount ?? 0,
        totalRecords: data.stats?.totalRecords ?? 0,
      })
      setTotalPages(data.pagination?.totalPages || 1)
      setTotalCount(data.pagination?.totalCount || 0)
    } catch (error) {
      console.error("Error fetching profits history:", error)
      toast.error(error instanceof Error ? error.message : "Failed to fetch profits history")
    } finally {
      setLoading(false)
    }
  }, [page, search, statusFilter, startDate, endDate])

  useEffect(() => {
    fetchProfits()
  }, [fetchProfits])

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1)
  }, [search, statusFilter, startDate, endDate])

  const handleExport = async () => {
    setExporting(true)
    try {
      const params = new URLSearchParams()
      if (search) params.append("search", search)
      if (statusFilter !== "all") params.append("status", statusFilter)
      if (startDate) params.append("startDate", startDate)
      if (endDate) params.append("endDate", endDate)
      params.append("limit", "10000") // Get all matching records

      const response = await fetch(`/api/admin/profits-history?${params}`)
      const data = await response.json()

      if (!response.ok) throw new Error(data.error)

      // Create CSV
      const headers = ["Date", "Shop Name", "Owner Email", "Owner Name", "Order Ref", "Network", "Size (GB)", "Balance Before", "Profit Amount", "Balance After", "Status", "Credited At"]
      const rows = data.profits.map((p: ProfitRecord) => [
        new Date(p.created_at).toLocaleString(),
        p.shop_name,
        p.owner_email,
        `${p.owner_first_name || ""} ${p.owner_last_name || ""}`.trim() || "N/A",
        p.order_reference || "N/A",
        p.order_network || "N/A",
        p.order_volume_gb || "N/A",
        p.profit_balance_before ?? "N/A",
        p.profit_amount,
        p.profit_balance_after ?? "N/A",
        p.status,
        p.credited_at ? new Date(p.credited_at).toLocaleString() : "N/A",
      ])

      const csv = [headers, ...rows].map((row: (string | number)[]) => row.map((cell: string | number) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n")
      
      const blob = new Blob([csv], { type: "text/csv" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `profits-history-${new Date().toISOString().split("T")[0]}.csv`
      a.click()
      URL.revokeObjectURL(url)

      toast.success(`Exported ${data.profits.length} profit records`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to export profits history")
    } finally {
      setExporting(false)
    }
  }

  const getStatusBadge = (status: string) => {
    switch (status.toLowerCase()) {
      case "credited":
        return <Badge className="bg-green-500 hover:bg-green-600"><CheckCircle className="w-3 h-3 mr-1" />Credited</Badge>
      case "pending":
        return <Badge className="bg-yellow-500 hover:bg-yellow-600"><Clock className="w-3 h-3 mr-1" />Pending</Badge>
      case "withdrawn":
        return <Badge className="bg-blue-500 hover:bg-blue-600"><Banknote className="w-3 h-3 mr-1" />Withdrawn</Badge>
      default:
        return <Badge variant="secondary">{status}</Badge>
    }
  }

  const clearFilters = () => {
    setSearch("")
    setStatusFilter("all")
    setStartDate("")
    setEndDate("")
  }

  return (
    <DashboardLayout>
      <div className="container mx-auto py-6 space-y-6">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold">Profits Crediting History</h1>
            <p className="text-muted-foreground">Track all shop profits and their crediting status</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => fetchProfits()} disabled={loading}>
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
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Profits</CardTitle>
              <TrendingUp className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">{formatCurrency(stats.totalProfit)}</div>
              <p className="text-xs text-muted-foreground">{stats.totalRecords} records</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending</CardTitle>
              <Clock className="h-4 w-4 text-yellow-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-yellow-600">{formatCurrency(stats.pendingProfit)}</div>
              <p className="text-xs text-muted-foreground">{stats.pendingCount} awaiting credit</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Credited</CardTitle>
              <Wallet className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">{formatCurrency(stats.creditedProfit)}</div>
              <p className="text-xs text-muted-foreground">{stats.creditedCount} credited</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Withdrawn</CardTitle>
              <Banknote className="h-4 w-4 text-blue-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-600">{formatCurrency(stats.withdrawnProfit)}</div>
              <p className="text-xs text-muted-foreground">{stats.withdrawnCount} withdrawn</p>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <Card>
          <CardHeader>
            <CardTitle>Filters</CardTitle>
            <CardDescription>Search and filter profit records</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
              <div className="lg:col-span-2">
                <Label htmlFor="search">Search</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="search"
                    placeholder="Shop name, owner email, order ref..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
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
                    <SelectItem value="credited">Credited</SelectItem>
                    <SelectItem value="withdrawn">Withdrawn</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-end">
                <Button variant="ghost" onClick={clearFilters} className="w-full">
                  Clear Filters
                </Button>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-2 mt-4">
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

        {/* Profits Table */}
        <Card>
          <CardHeader>
            <CardTitle>
              Profit Records
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
            ) : profits.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                <XCircle className="w-12 h-12 mb-4" />
                <p>No profit records found</p>
                <p className="text-sm">Try adjusting your filters</p>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <Table className="min-w-[1200px] w-full text-xs sm:text-sm">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Shop</TableHead>
                        <TableHead>Owner</TableHead>
                        <TableHead>Order Ref</TableHead>
                        <TableHead>Network</TableHead>
                        <TableHead>Size</TableHead>
                        <TableHead>Balance Before</TableHead>
                        <TableHead>Profit</TableHead>
                        <TableHead>Balance After</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Credited At</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {profits.map((profit) => (
                        <TableRow key={profit.id}>
                          <TableCell className="whitespace-nowrap">
                            {new Date(profit.created_at).toLocaleString()}
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-col">
                              <span className="font-medium">{profit.shop_name}</span>
                              <span className="text-xs text-muted-foreground">/{profit.shop_slug}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-col">
                              <span className="font-medium">{profit.owner_email}</span>
                              <span className="text-sm text-muted-foreground">
                                {`${profit.owner_first_name || ""} ${profit.owner_last_name || ""}`.trim() || "No name"}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {profit.order_reference || "-"}
                          </TableCell>
                          <TableCell>
                            {profit.order_network || "-"}
                          </TableCell>
                          <TableCell>
                            {profit.order_volume_gb ? `${profit.order_volume_gb} GB` : "-"}
                          </TableCell>
                          <TableCell className="font-medium text-muted-foreground">
                            {profit.profit_balance_before != null 
                              ? formatCurrency(profit.profit_balance_before) 
                              : "-"
                            }
                          </TableCell>
                          <TableCell className="font-medium text-green-600">
                            +{formatCurrency(profit.profit_amount)}
                          </TableCell>
                          <TableCell className="font-medium text-blue-600">
                            {profit.profit_balance_after != null 
                              ? formatCurrency(profit.profit_balance_after) 
                              : "-"
                            }
                          </TableCell>
                          <TableCell>{getStatusBadge(profit.status)}</TableCell>
                          <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                            {profit.credited_at 
                              ? new Date(profit.credited_at).toLocaleString()
                              : "-"
                            }
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                {/* Pagination */}
                <div className="flex items-center justify-between mt-4">
                  <p className="text-sm text-muted-foreground">
                    Showing {(page - 1) * limit + 1} to {Math.min(page * limit, totalCount)} of {totalCount} records
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
