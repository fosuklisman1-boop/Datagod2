"use client"

import { useState, useEffect } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Download, Loader2, Calendar as CalendarIcon, Filter } from "lucide-react"
import { toast } from "sonner"
import { format } from "date-fns"
import { useAdminProtected } from "@/hooks/use-admin"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabase"

interface OrderHistoryStats {
    totalOrders: number
    totalVolume: number
    totalRevenue: number
}

interface OrderHistoryItem {
    id: string
    type: "bulk" | "shop"
    created_at: string
    phone: string
    network: string
    size: number
    price: number
    status: string
}

export default function OrderHistoryPage() {
    const router = useRouter()
    const { isAdmin, loading: adminLoading } = useAdminProtected()
    const [loading, setLoading] = useState(false)
    const [orders, setOrders] = useState<OrderHistoryItem[]>([])
    const [stats, setStats] = useState<OrderHistoryStats>({ totalOrders: 0, totalVolume: 0, totalRevenue: 0 })

    // Filters
    // Default to today
    const today = new Date().toISOString().split('T')[0]
    const [dateFrom, setDateFrom] = useState(today)
    const [dateTo, setDateTo] = useState(today)
    const [network, setNetwork] = useState("all")

    const fetchData = async () => {
        try {
            setLoading(true)

            // Get Supabase session for Authorization
            const { data: { session } } = await supabase.auth.getSession()
            if (!session?.access_token) {
                toast.error("Authentication required")
                setLoading(false)
                return
            }

            // Adjust dates to cover full days
            const start = new Date(dateFrom)
            start.setHours(0, 0, 0, 0)

            const end = new Date(dateTo)
            end.setHours(23, 59, 59, 999)

            const response = await fetch(
                `/api/admin/order-history?dateFrom=${start.toISOString()}&dateTo=${end.toISOString()}&network=${network}`,
                {
                    headers: {
                        Authorization: `Bearer ${session.access_token}`
                    }
                }
            )

            console.log('[ORDER-HISTORY-FRONTEND] Response status:', response.status)

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Unknown error' }))
                console.error('[ORDER-HISTORY-FRONTEND] Error response:', errorData)
                throw new Error(errorData.error || errorData.details || `HTTP ${response.status}`)
            }

            const data = await response.json()
            setOrders(data.orders || [])
            setStats(data.stats || { totalOrders: 0, totalVolume: 0, totalRevenue: 0 })

        } catch (error) {
            console.error("Error fetching history:", error)
            toast.error("Failed to load order history")
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        fetchData()
    }, []) // Initial load only? Or on filter change? 
    // Better on filter change usually, or manual "Apply Filter" button.
    // Let's do manual apply to avoid too many requests while picking dates.

    const handleApplyFilters = () => {
        fetchData()
    }

    const handleDownload = () => {
        if (orders.length === 0) {
            toast.error("No orders to download")
            return
        }

        // Convert to CSV
        const headers = ["Date", "Type", "Network", "Phone", "Size (GB)", "Price (GHS)", "Status"]
        const csvContent = [
            headers.join(","),
            ...orders.map(o => [
                new Date(o.created_at).toLocaleString(),
                o.type,
                o.network,
                o.phone,
                o.size,
                o.price,
                o.status
            ].join(","))
        ].join("\n")

        const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" })
        const link = document.createElement("a")
        const url = URL.createObjectURL(blob)
        link.setAttribute("href", url)
        link.setAttribute("download", `order_history_${dateFrom}_to_${dateTo}.csv`)
        link.style.visibility = "hidden"
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
    }

    if (adminLoading) {
        return (
            <DashboardLayout>
                <div className="flex items-center justify-center h-screen">
                    <Loader2 className="w-8 h-8 animate-spin" />
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
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Order History</h1>
                    <p className="text-muted-foreground">View and export completed order statistics.</p>
                </div>

                {/* Filters */}
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-lg font-medium flex items-center gap-2">
                            <Filter className="w-4 h-4" /> Filters
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="flex flex-wrap items-end gap-4">
                            <div className="grid gap-1.5">
                                <label className="text-sm font-medium">From Date</label>
                                <Input
                                    type="date"
                                    value={dateFrom}
                                    onChange={(e) => setDateFrom(e.target.value)}
                                    className="w-[180px]"
                                />
                            </div>
                            <div className="grid gap-1.5">
                                <label className="text-sm font-medium">To Date</label>
                                <Input
                                    type="date"
                                    value={dateTo}
                                    onChange={(e) => setDateTo(e.target.value)}
                                    className="w-[180px]"
                                />
                            </div>
                            <div className="grid gap-1.5">
                                <label className="text-sm font-medium">Network</label>
                                <Select value={network} onValueChange={setNetwork}>
                                    <SelectTrigger className="w-[180px]">
                                        <SelectValue placeholder="All Networks" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">All Networks</SelectItem>
                                        <SelectItem value="MTN">MTN</SelectItem>
                                        <SelectItem value="Telecel">Telecel</SelectItem>
                                        <SelectItem value="AT">AT</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <Button onClick={handleApplyFilters} disabled={loading}>
                                {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                                Apply Filters
                            </Button>
                            <Button variant="outline" onClick={handleDownload} disabled={loading || orders.length === 0} className="ml-auto">
                                <Download className="w-4 h-4 mr-2" />
                                Download CSV
                            </Button>
                        </div>
                    </CardContent>
                </Card>

                {/* Stats Cards */}
                <div className="grid gap-4 md:grid-cols-3">
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                            <CardTitle className="text-sm font-medium">Total Volume</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="text-2xl font-bold">{stats.totalVolume.toFixed(2)} GB</div>
                            <p className="text-xs text-muted-foreground">
                                For selected period
                            </p>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                            <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="text-2xl font-bold">GHS {stats.totalRevenue.toFixed(2)}</div>
                            <p className="text-xs text-muted-foreground">
                                For selected period
                            </p>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                            <CardTitle className="text-sm font-medium">Total Orders</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="text-2xl font-bold">{stats.totalOrders}</div>
                            <p className="text-xs text-muted-foreground">
                                Completed transactions
                            </p>
                        </CardContent>
                    </Card>
                </div>

                {/* Orders Table */}
                <Card>
                    <CardHeader>
                        <CardTitle>Orders List</CardTitle>
                        <CardDescription>
                            Showing {orders.length} orders
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        {loading ? (
                            <div className="flex justify-center py-8">
                                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                            </div>
                        ) : orders.length === 0 ? (
                            <div className="text-center py-8 text-muted-foreground">
                                No orders found for the selected criteria.
                            </div>
                        ) : (
                            <div className="rounded-md border">
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>Date</TableHead>
                                            <TableHead>Type</TableHead>
                                            <TableHead>Network</TableHead>
                                            <TableHead>Phone</TableHead>
                                            <TableHead>Size</TableHead>
                                            <TableHead className="text-right">Price</TableHead>
                                            <TableHead className="text-center">Status</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {orders.map((order) => (
                                            <TableRow key={`${order.type}-${order.id}`}>
                                                <TableCell>
                                                    <div className="flex flex-col">
                                                        <span className="font-medium">{format(new Date(order.created_at), "MMM d, yyyy")}</span>
                                                        <span className="text-xs text-muted-foreground">{format(new Date(order.created_at), "h:mm a")}</span>
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <Badge variant="outline" className="capitalize">{order.type}</Badge>
                                                </TableCell>
                                                <TableCell>{order.network}</TableCell>
                                                <TableCell className="font-mono">{order.phone}</TableCell>
                                                <TableCell>{order.size} GB</TableCell>
                                                <TableCell className="text-right">GHS {order.price?.toFixed(2)}</TableCell>
                                                <TableCell className="text-center">
                                                    <Badge variant="secondary" className="bg-green-100 text-green-800 hover:bg-green-100">
                                                        {order.status}
                                                    </Badge>
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>
        </DashboardLayout>
    )
}
