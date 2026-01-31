"use client"

import { useEffect, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
    Users,
    Calendar,
    Search,
    Filter,
    Clock,
    AlertCircle,
    CheckCircle2,
    ArrowUpDown,
    ExternalLink,
    Crown,
    Loader2
} from "lucide-react"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { format } from "date-fns"

interface Subscription {
    id: string
    user_id: string
    status: string
    start_date: string
    end_date: string
    amount_paid: number
    payment_reference: string
    user: {
        first_name: string
        last_name: string
        email: string
        phone_number: string
    }
    plan: {
        name: string
        duration_days: number
    }
}

export default function AdminSubscribersPage() {
    const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
    const [loading, setLoading] = useState(true)
    const [isAdmin, setIsAdmin] = useState(false)
    const [adminLoading, setAdminLoading] = useState(true)
    const [searchQuery, setSearchQuery] = useState("")
    const [statusFilter, setStatusFilter] = useState<string>("all")

    useEffect(() => {
        checkAdminAccess()
    }, [])

    const checkAdminAccess = async () => {
        try {
            const { data: { user } } = await supabase.auth.getUser()
            if (!user) {
                window.location.href = "/login"
                return
            }

            const { data: profile } = await supabase
                .from("users")
                .select("role")
                .eq("id", user.id)
                .single()

            if (profile?.role !== "admin") {
                toast.error("Unauthorized access")
                window.location.href = "/dashboard"
                return
            }

            setIsAdmin(true)
            await fetchSubscriptions()
        } catch (error) {
            console.error("Error checking admin access:", error)
            window.location.href = "/dashboard"
        } finally {
            setAdminLoading(false)
        }
    }

    const fetchSubscriptions = async () => {
        try {
            const { data: { session } } = await supabase.auth.getSession()
            const headers: HeadersInit = {}
            if (session?.access_token) {
                headers["Authorization"] = `Bearer ${session.access_token}`
            }

            const response = await fetch("/api/admin/subscriptions", { headers })
            const data = await response.json()
            if (data.subscriptions) {
                setSubscriptions(data.subscriptions)
            } else if (data.error) {
                toast.error(data.error)
            }
        } catch (error) {
            console.error("Error fetching subscriptions:", error)
            toast.error("Failed to load subscribers")
        } finally {
            setLoading(false)
        }
    }

    const filteredSubscriptions = subscriptions.filter(sub => {
        const fullName = `${sub.user?.first_name || ""} ${sub.user?.last_name || ""}`.toLowerCase()
        const matchesSearch =
            fullName.includes(searchQuery.toLowerCase()) ||
            sub.user?.email?.toLowerCase().includes(searchQuery.toLowerCase()) ||
            sub.user?.phone_number?.includes(searchQuery)

        const matchesStatus = statusFilter === "all" || sub.status === statusFilter

        return matchesSearch && matchesStatus
    })

    const getDaysRemaining = (endDate: string) => {
        const diff = new Date(endDate).getTime() - new Date().getTime()
        const days = Math.ceil(diff / (1000 * 60 * 60 * 24))
        return days
    }

    const stats = {
        active: subscriptions.filter(s => s.status === "active").length,
        expired: subscriptions.filter(s => s.status === "expired" || s.status === "cancelled").length,
        totalRevenue: subscriptions.reduce((sum, s) => sum + (Number(s.amount_paid) || 0), 0)
    }

    if (adminLoading) {
        return (
            <DashboardLayout>
                <div className="flex items-center justify-center min-h-[60vh]">
                    <Loader2 className="w-8 h-8 animate-spin text-amber-600" />
                </div>
            </DashboardLayout>
        )
    }

    if (!isAdmin) return null

    return (
        <DashboardLayout>
            <div className="p-6 max-w-7xl mx-auto">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight">Dealer Subscriptions</h1>
                        <p className="text-muted-foreground">Monitor and manage all dealer memberships</p>
                    </div>
                    <div className="flex items-center gap-4">
                        <Button variant="outline" onClick={fetchSubscriptions} disabled={loading}>
                            Refresh Data
                        </Button>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                    <Card className="bg-gradient-to-br from-amber-50 to-orange-50 border-amber-100">
                        <CardHeader className="flex flex-row items-center justify-between pb-2">
                            <CardTitle className="text-sm font-medium text-amber-900">Active Dealers</CardTitle>
                            <Crown className="h-4 w-4 text-amber-600" />
                        </CardHeader>
                        <CardContent>
                            <div className="text-2xl font-bold text-amber-950">{stats.active}</div>
                            <p className="text-xs text-amber-700/70 mt-1">Currently powered up</p>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between pb-2">
                            <CardTitle className="text-sm font-medium">Expired/Cancelled</CardTitle>
                            <Clock className="h-4 w-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                            <div className="text-2xl font-bold">{stats.expired}</div>
                            <p className="text-xs text-muted-foreground mt-1 text-red-500">Accounts reverted to 'user'</p>
                        </CardContent>
                    </Card>
                    <Card className="bg-gradient-to-br from-blue-50 to-indigo-50 border-blue-100">
                        <CardHeader className="flex flex-row items-center justify-between pb-2">
                            <CardTitle className="text-sm font-medium text-blue-900">Total Subscription Revenue</CardTitle>
                            <ArrowUpDown className="h-4 w-4 text-blue-600" />
                        </CardHeader>
                        <CardContent>
                            <div className="text-2xl font-bold text-blue-950">GHS {stats.totalRevenue.toFixed(2)}</div>
                            <p className="text-xs text-blue-700/70 mt-1">Lifetime membership fees</p>
                        </CardContent>
                    </Card>
                </div>

                <Card>
                    <CardHeader>
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                            <div className="relative w-full md:w-96">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                <Input
                                    placeholder="Search by name, email or phone..."
                                    className="pl-9"
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                />
                            </div>
                            <div className="flex items-center gap-2">
                                <Filter className="h-4 w-4 text-muted-foreground" />
                                <select
                                    className="bg-background border rounded-md px-3 py-2 text-sm focus:outline-none ring-offset-background border-input"
                                    value={statusFilter}
                                    onChange={(e) => setStatusFilter(e.target.value)}
                                >
                                    <option value="all">All Status</option>
                                    <option value="active">Active</option>
                                    <option value="expired">Expired</option>
                                    <option value="cancelled">Cancelled</option>
                                </select>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b bg-muted/50">
                                        <th className="text-left p-4 font-medium">Subscriber</th>
                                        <th className="text-left p-4 font-medium">Plan</th>
                                        <th className="text-left p-4 font-medium">Period</th>
                                        <th className="text-left p-4 font-medium">Status / Expiry</th>
                                        <th className="text-left p-4 font-medium text-right">Paid</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {loading ? (
                                        Array(5).fill(0).map((_, i) => (
                                            <tr key={i} className="border-b animate-pulse text-transparent select-none">
                                                <td className="p-4"><div className="h-4 bg-gray-200 rounded w-32"></div></td>
                                                <td className="p-4"><div className="h-4 bg-gray-200 rounded w-24"></div></td>
                                                <td className="p-4"><div className="h-4 bg-gray-200 rounded w-40"></div></td>
                                                <td className="p-4"><div className="h-4 bg-gray-200 rounded w-20"></div></td>
                                                <td className="p-4 text-right"><div className="h-4 bg-gray-200 rounded w-16 ml-auto"></div></td>
                                            </tr>
                                        ))
                                    ) : filteredSubscriptions.length === 0 ? (
                                        <tr>
                                            <td colSpan={5} className="p-8 text-center text-muted-foreground">
                                                No subscribers found
                                            </td>
                                        </tr>
                                    ) : (
                                        filteredSubscriptions.map((sub) => {
                                            const daysRemaining = getDaysRemaining(sub.end_date)
                                            return (
                                                <tr key={sub.id} className="border-b hover:bg-muted/30 transition-colors">
                                                    <td className="p-4">
                                                        <div className="font-medium">{sub.user?.first_name} {sub.user?.last_name}</div>
                                                        <div className="text-xs text-muted-foreground mt-0.5">{sub.user?.email}</div>
                                                        <div className="text-xs text-muted-foreground">{sub.user?.phone_number}</div>
                                                    </td>
                                                    <td className="p-4">
                                                        <Badge variant="secondary" className="bg-blue-50 text-blue-700 hover:bg-blue-50 border-blue-100">
                                                            {sub.plan?.name || "Premium Plan"}
                                                        </Badge>
                                                    </td>
                                                    <td className="p-4">
                                                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                                            <Calendar className="h-3 w-3" />
                                                            {format(new Date(sub.start_date), "MMM d, yyyy")}
                                                            <span>→</span>
                                                            {format(new Date(sub.end_date), "MMM d, yyyy")}
                                                        </div>
                                                    </td>
                                                    <td className="p-4">
                                                        <div className="flex flex-col gap-1">
                                                            <Badge
                                                                className={
                                                                    sub.status === "active"
                                                                        ? "bg-green-100 text-green-700 hover:bg-green-100 border-green-200 w-fit"
                                                                        : "bg-red-100 text-red-700 hover:bg-red-100 border-red-200 w-fit"
                                                                }
                                                            >
                                                                {sub.status.toUpperCase()}
                                                            </Badge>
                                                            {sub.status === "active" && (
                                                                <div className={`text-[10px] font-bold mt-1 flex items-center gap-1 ${daysRemaining <= 7 ? "text-red-500" : "text-amber-600"}`}>
                                                                    <Clock className="h-3 w-3" />
                                                                    {daysRemaining > 0 ? `${daysRemaining} days left` : "Expires today"}
                                                                </div>
                                                            )}
                                                        </div>
                                                    </td>
                                                    <td className="p-4 text-right font-medium">
                                                        GHS {Number(sub.amount_paid).toFixed(2)}
                                                    </td>
                                                </tr>
                                            )
                                        })
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </DashboardLayout>
    )
}
