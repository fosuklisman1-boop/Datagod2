"use client"

import { useEffect, useState } from "react"
import { useRouter, useParams } from "next/navigation"
import { useAuth } from "@/hooks/use-auth"
import { AdminLayout } from "@/components/layout/admin-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { supabase } from "@/lib/supabase"
import {
    Users,
    DollarSign,
    Store,
    Loader2,
    ArrowLeft,
    ShoppingCart,
    Phone,
    Calendar,
    Wifi,
    TrendingUp,
    CheckCircle,
    AlertCircle,
    User
} from "lucide-react"

interface SubAgent {
    id: string
    shop_name: string
    shop_slug: string
    owner_email: string
    is_active: boolean
    total_orders: number
    total_order_value: number
    total_profit_to_parent: number
}

interface ProfitHistoryItem {
    id: string
    reference_code: string
    sub_agent_id: string
    sub_agent_name: string
    customer_phone: string
    customer_name: string
    network: string
    volume_gb: number
    order_total: number
    profit_amount: number
    profit_status: string
    created_at: string
}

interface ParentShopDetails {
    id: string
    shop_name: string
    shop_slug: string
    owner_email: string
    owner_phone: string | null
    is_active: boolean
    available_balance: number
    total_profit: number
    credited_profit: number
    withdrawn_amount: number
}

interface Summary {
    total_sub_agents: number
    total_orders: number
    total_order_value: number
    total_earned_from_subagents: number
    profit_records_count: number
}

export default function SubAgentProfitDetailPage() {
    const { user, loading: authLoading } = useAuth()
    const router = useRouter()
    const params = useParams()
    const shopId = params.shopId as string

    const [parentShop, setParentShop] = useState<ParentShopDetails | null>(null)
    const [summary, setSummary] = useState<Summary | null>(null)
    const [subAgents, setSubAgents] = useState<SubAgent[]>([])
    const [profitHistory, setProfitHistory] = useState<ProfitHistoryItem[]>([])
    const [loading, setLoading] = useState(true)
    const [selectedSubAgent, setSelectedSubAgent] = useState<string | null>(null)

    useEffect(() => {
        if (!authLoading && user && shopId) {
            loadData()
        }
    }, [user, authLoading, shopId])

    const loadData = async () => {
        try {
            setLoading(true)
            const { data: { session } } = await supabase.auth.getSession()

            if (!session?.access_token) {
                router.push("/auth/login")
                return
            }

            const response = await fetch(`/api/admin/sub-agent-profits/${shopId}`, {
                headers: {
                    Authorization: `Bearer ${session.access_token}`
                }
            })

            if (!response.ok) {
                if (response.status === 404) {
                    router.push("/admin/sub-agent-profits")
                    return
                }
                throw new Error("Failed to fetch data")
            }

            const data = await response.json()
            setParentShop(data.parent_shop)
            setSummary(data.summary)
            setSubAgents(data.sub_agents || [])
            setProfitHistory(data.profit_history || [])
        } catch (error) {
            console.error("Error loading sub-agent profit details:", error)
        } finally {
            setLoading(false)
        }
    }

    const filteredHistory = selectedSubAgent
        ? profitHistory.filter(h => h.sub_agent_id === selectedSubAgent)
        : profitHistory

    const getNetworkColor = (network: string) => {
        const n = network?.toLowerCase() || ""
        if (n.includes("mtn")) return "bg-yellow-100 text-yellow-800"
        if (n.includes("telecel") || n.includes("vodafone")) return "bg-red-100 text-red-800"
        if (n.includes("at") || n.includes("airteltigo")) return "bg-blue-100 text-blue-800"
        return "bg-gray-100 text-gray-800"
    }

    if (authLoading || loading) {
        return (
            <AdminLayout>
                <div className="flex items-center justify-center min-h-[400px]">
                    <Loader2 className="w-8 h-8 animate-spin text-violet-600" />
                </div>
            </AdminLayout>
        )
    }

    if (!parentShop) {
        return (
            <AdminLayout>
                <div className="text-center py-12">
                    <p className="text-gray-500">Shop not found</p>
                    <Button
                        className="mt-4"
                        onClick={() => router.push("/admin/sub-agent-profits")}
                    >
                        Back to List
                    </Button>
                </div>
            </AdminLayout>
        )
    }

    return (
        <AdminLayout>
            <div className="space-y-6">
                {/* Back Button */}
                <Button
                    variant="ghost"
                    onClick={() => router.push("/admin/sub-agent-profits")}
                    className="mb-2"
                >
                    <ArrowLeft className="h-4 w-4 mr-2" />
                    Back to Sub-Agent Profits
                </Button>

                {/* Parent Shop Header */}
                <Card className="bg-gradient-to-r from-violet-50 via-purple-50 to-fuchsia-50 border-violet-200">
                    <CardHeader>
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-4">
                                <div className="p-3 bg-violet-100 rounded-xl">
                                    <Store className="h-8 w-8 text-violet-600" />
                                </div>
                                <div>
                                    <CardTitle className="text-2xl flex items-center gap-2">
                                        {parentShop.shop_name}
                                        {parentShop.is_active ? (
                                            <Badge className="bg-green-100 text-green-700">Active</Badge>
                                        ) : (
                                            <Badge className="bg-gray-100 text-gray-600">Inactive</Badge>
                                        )}
                                    </CardTitle>
                                    <CardDescription className="text-base">
                                        /{parentShop.shop_slug} • {parentShop.owner_email}
                                        {parentShop.owner_phone && ` • ${parentShop.owner_phone}`}
                                    </CardDescription>
                                </div>
                            </div>
                            <div className="text-right">
                                <p className="text-sm text-gray-500">Available Balance</p>
                                <p className="text-3xl font-bold text-green-600">
                                    GHS {parentShop.available_balance.toFixed(2)}
                                </p>
                            </div>
                        </div>
                    </CardHeader>
                </Card>

                {/* Summary Stats */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
                    <Card>
                        <CardContent className="pt-6">
                            <div className="flex items-center gap-3">
                                <Users className="h-5 w-5 text-blue-500" />
                                <div>
                                    <p className="text-sm text-gray-500">Sub-Agents</p>
                                    <p className="text-xl font-bold">{summary?.total_sub_agents || 0}</p>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardContent className="pt-6">
                            <div className="flex items-center gap-3">
                                <ShoppingCart className="h-5 w-5 text-orange-500" />
                                <div>
                                    <p className="text-sm text-gray-500">Total Orders</p>
                                    <p className="text-xl font-bold">{summary?.total_orders || 0}</p>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardContent className="pt-6">
                            <div className="flex items-center gap-3">
                                <DollarSign className="h-5 w-5 text-cyan-500" />
                                <div>
                                    <p className="text-sm text-gray-500">Order Value</p>
                                    <p className="text-xl font-bold">GHS {(summary?.total_order_value || 0).toFixed(2)}</p>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="bg-green-50 border-green-200">
                        <CardContent className="pt-6">
                            <div className="flex items-center gap-3">
                                <TrendingUp className="h-5 w-5 text-green-600" />
                                <div>
                                    <p className="text-sm text-green-700">Earned from Sub-Agents</p>
                                    <p className="text-xl font-bold text-green-700">
                                        GHS {(summary?.total_earned_from_subagents || 0).toFixed(2)}
                                    </p>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardContent className="pt-6">
                            <div className="flex items-center gap-3">
                                <CheckCircle className="h-5 w-5 text-violet-500" />
                                <div>
                                    <p className="text-sm text-gray-500">Profit Records</p>
                                    <p className="text-xl font-bold">{summary?.profit_records_count || 0}</p>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </div>

                {/* Sub-Agents Section */}
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Users className="h-5 w-5 text-blue-500" />
                            Sub-Agents
                        </CardTitle>
                        <CardDescription>
                            Click on a sub-agent to filter the profit history
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        {subAgents.length === 0 ? (
                            <p className="text-gray-500 text-center py-4">No sub-agents found</p>
                        ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                {subAgents.map((sa) => (
                                    <div
                                        key={sa.id}
                                        onClick={() => setSelectedSubAgent(
                                            selectedSubAgent === sa.id ? null : sa.id
                                        )}
                                        className={`p-4 rounded-lg border cursor-pointer transition-all ${selectedSubAgent === sa.id
                                                ? "border-violet-500 bg-violet-50 ring-2 ring-violet-200"
                                                : "border-gray-200 hover:border-violet-300 hover:bg-gray-50"
                                            }`}
                                    >
                                        <div className="flex items-start justify-between mb-3">
                                            <div>
                                                <p className="font-semibold text-gray-900">{sa.shop_name}</p>
                                                <p className="text-xs text-gray-500">{sa.owner_email}</p>
                                            </div>
                                            {sa.is_active ? (
                                                <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 text-xs">
                                                    Active
                                                </Badge>
                                            ) : (
                                                <Badge variant="outline" className="text-xs">Inactive</Badge>
                                            )}
                                        </div>
                                        <div className="grid grid-cols-3 gap-2 text-sm">
                                            <div className="text-center p-2 bg-gray-50 rounded">
                                                <p className="text-gray-500 text-xs">Orders</p>
                                                <p className="font-bold">{sa.total_orders}</p>
                                            </div>
                                            <div className="text-center p-2 bg-gray-50 rounded">
                                                <p className="text-gray-500 text-xs">Value</p>
                                                <p className="font-bold">GHS {sa.total_order_value.toFixed(0)}</p>
                                            </div>
                                            <div className="text-center p-2 bg-green-50 rounded">
                                                <p className="text-green-700 text-xs">Profit</p>
                                                <p className="font-bold text-green-700">GHS {sa.total_profit_to_parent.toFixed(2)}</p>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Profit History Table */}
                <Card>
                    <CardHeader>
                        <div className="flex items-center justify-between">
                            <div>
                                <CardTitle className="flex items-center gap-2">
                                    <DollarSign className="h-5 w-5 text-green-500" />
                                    Profit History
                                </CardTitle>
                                <CardDescription>
                                    {selectedSubAgent
                                        ? `Showing orders from: ${subAgents.find(s => s.id === selectedSubAgent)?.shop_name}`
                                        : "All profit transactions from sub-agent orders"
                                    }
                                </CardDescription>
                            </div>
                            {selectedSubAgent && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setSelectedSubAgent(null)}
                                >
                                    Clear Filter
                                </Button>
                            )}
                        </div>
                    </CardHeader>
                    <CardContent>
                        {filteredHistory.length === 0 ? (
                            <div className="text-center py-8">
                                <ShoppingCart className="h-12 w-12 mx-auto text-gray-300 mb-4" />
                                <p className="text-gray-500">No profit transactions found</p>
                            </div>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead className="bg-gray-50 border-b">
                                        <tr>
                                            <th className="px-4 py-3 text-left font-semibold text-gray-900">Date</th>
                                            <th className="px-4 py-3 text-left font-semibold text-gray-900">Reference</th>
                                            <th className="px-4 py-3 text-left font-semibold text-gray-900">Sub-Agent</th>
                                            <th className="px-4 py-3 text-left font-semibold text-gray-900">Customer</th>
                                            <th className="px-4 py-3 text-left font-semibold text-gray-900">Network</th>
                                            <th className="px-4 py-3 text-right font-semibold text-gray-900">Order Total</th>
                                            <th className="px-4 py-3 text-right font-semibold text-gray-900">Profit</th>
                                            <th className="px-4 py-3 text-center font-semibold text-gray-900">Status</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y">
                                        {filteredHistory.map((item) => (
                                            <tr key={item.id} className="hover:bg-gray-50">
                                                <td className="px-4 py-3 text-gray-600">
                                                    <div className="flex items-center gap-1">
                                                        <Calendar className="h-3 w-3" />
                                                        {new Date(item.created_at).toLocaleDateString()}
                                                    </div>
                                                    <p className="text-xs text-gray-400">
                                                        {new Date(item.created_at).toLocaleTimeString()}
                                                    </p>
                                                </td>
                                                <td className="px-4 py-3 font-mono text-xs">
                                                    {item.reference_code}
                                                </td>
                                                <td className="px-4 py-3">
                                                    <p className="font-medium">{item.sub_agent_name}</p>
                                                </td>
                                                <td className="px-4 py-3">
                                                    <div className="flex items-center gap-1">
                                                        <Phone className="h-3 w-3 text-gray-400" />
                                                        {item.customer_phone}
                                                    </div>
                                                    {item.customer_name && (
                                                        <p className="text-xs text-gray-500">{item.customer_name}</p>
                                                    )}
                                                </td>
                                                <td className="px-4 py-3">
                                                    <Badge className={getNetworkColor(item.network)}>
                                                        {item.network}
                                                    </Badge>
                                                    <span className="text-xs text-gray-500 ml-1">{item.volume_gb}GB</span>
                                                </td>
                                                <td className="px-4 py-3 text-right font-medium">
                                                    GHS {item.order_total.toFixed(2)}
                                                </td>
                                                <td className="px-4 py-3 text-right font-bold text-green-600">
                                                    +GHS {item.profit_amount.toFixed(2)}
                                                </td>
                                                <td className="px-4 py-3 text-center">
                                                    {item.profit_status === "credited" ? (
                                                        <Badge className="bg-green-100 text-green-700">
                                                            <CheckCircle className="h-3 w-3 mr-1" />
                                                            Credited
                                                        </Badge>
                                                    ) : item.profit_status === "missing" ? (
                                                        <Badge className="bg-red-100 text-red-700">
                                                            <AlertCircle className="h-3 w-3 mr-1" />
                                                            Missing
                                                        </Badge>
                                                    ) : (
                                                        <Badge className="bg-gray-100 text-gray-600">
                                                            {item.profit_status}
                                                        </Badge>
                                                    )}
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
        </AdminLayout>
    )
}
