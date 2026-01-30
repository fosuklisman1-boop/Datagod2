"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/hooks/use-auth"
import { AdminLayout } from "@/components/layout/admin-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { supabase } from "@/lib/supabase"
import {
    Users,
    DollarSign,
    Store,
    Search,
    Eye,
    Loader2,
    TrendingUp,
    ArrowUpRight,
    ChevronDown,
    ChevronUp
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
    last_order_date: string | null
}

interface ParentShop {
    id: string
    shop_name: string
    shop_slug: string
    owner_email: string
    is_active: boolean
    total_sub_agents: number
    total_orders_from_subagents: number
    total_earned_from_subagents: number
    sub_agents: SubAgent[]
}

export default function SubAgentProfitsPage() {
    const { user, loading: authLoading } = useAuth()
    const router = useRouter()
    const [parentShops, setParentShops] = useState<ParentShop[]>([])
    const [loading, setLoading] = useState(true)
    const [searchQuery, setSearchQuery] = useState("")
    const [expandedShops, setExpandedShops] = useState<Set<string>>(new Set())

    useEffect(() => {
        if (!authLoading && user) {
            loadData()
        }
    }, [user, authLoading])

    const loadData = async () => {
        try {
            setLoading(true)
            const { data: { session } } = await supabase.auth.getSession()

            if (!session?.access_token) {
                router.push("/auth/login")
                return
            }

            const response = await fetch("/api/admin/sub-agent-profits", {
                headers: {
                    Authorization: `Bearer ${session.access_token}`
                }
            })

            if (!response.ok) {
                throw new Error("Failed to fetch data")
            }

            const data = await response.json()
            setParentShops(data.parentShops || [])
        } catch (error) {
            console.error("Error loading sub-agent profits:", error)
        } finally {
            setLoading(false)
        }
    }

    const toggleExpand = (shopId: string) => {
        setExpandedShops(prev => {
            const newSet = new Set(prev)
            if (newSet.has(shopId)) {
                newSet.delete(shopId)
            } else {
                newSet.add(shopId)
            }
            return newSet
        })
    }

    const filteredShops = parentShops.filter(shop => {
        const query = searchQuery.toLowerCase()
        return (
            shop.shop_name?.toLowerCase().includes(query) ||
            shop.shop_slug?.toLowerCase().includes(query) ||
            shop.owner_email?.toLowerCase().includes(query)
        )
    })

    // Calculate totals
    const totalParentShops = parentShops.length
    const totalSubAgents = parentShops.reduce((sum, s) => sum + s.total_sub_agents, 0)
    const totalEarned = parentShops.reduce((sum, s) => sum + s.total_earned_from_subagents, 0)
    const totalOrders = parentShops.reduce((sum, s) => sum + s.total_orders_from_subagents, 0)

    if (authLoading || loading) {
        return (
            <AdminLayout>
                <div className="flex items-center justify-center min-h-[400px]">
                    <Loader2 className="w-8 h-8 animate-spin text-violet-600" />
                </div>
            </AdminLayout>
        )
    }

    return (
        <AdminLayout>
            <div className="space-y-6">
                {/* Header */}
                <div>
                    <h1 className="text-3xl font-bold text-gray-900">Sub-Agent Profits</h1>
                    <p className="text-gray-600 mt-1">
                        View parent shops and the profits they earn from their sub-agents
                    </p>
                </div>

                {/* Stats Cards */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    <Card className="bg-gradient-to-br from-violet-50 to-purple-50 border-violet-200">
                        <CardContent className="pt-6">
                            <div className="flex items-center gap-4">
                                <div className="p-3 bg-violet-100 rounded-lg">
                                    <Store className="h-6 w-6 text-violet-600" />
                                </div>
                                <div>
                                    <p className="text-sm text-gray-600">Parent Shops</p>
                                    <p className="text-2xl font-bold text-violet-700">{totalParentShops}</p>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="bg-gradient-to-br from-blue-50 to-cyan-50 border-blue-200">
                        <CardContent className="pt-6">
                            <div className="flex items-center gap-4">
                                <div className="p-3 bg-blue-100 rounded-lg">
                                    <Users className="h-6 w-6 text-blue-600" />
                                </div>
                                <div>
                                    <p className="text-sm text-gray-600">Total Sub-Agents</p>
                                    <p className="text-2xl font-bold text-blue-700">{totalSubAgents}</p>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="bg-gradient-to-br from-green-50 to-emerald-50 border-green-200">
                        <CardContent className="pt-6">
                            <div className="flex items-center gap-4">
                                <div className="p-3 bg-green-100 rounded-lg">
                                    <DollarSign className="h-6 w-6 text-green-600" />
                                </div>
                                <div>
                                    <p className="text-sm text-gray-600">Total Earned</p>
                                    <p className="text-2xl font-bold text-green-700">GHS {totalEarned.toFixed(2)}</p>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="bg-gradient-to-br from-orange-50 to-amber-50 border-orange-200">
                        <CardContent className="pt-6">
                            <div className="flex items-center gap-4">
                                <div className="p-3 bg-orange-100 rounded-lg">
                                    <TrendingUp className="h-6 w-6 text-orange-600" />
                                </div>
                                <div>
                                    <p className="text-sm text-gray-600">Sub-Agent Orders</p>
                                    <p className="text-2xl font-bold text-orange-700">{totalOrders}</p>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </div>

                {/* Search */}
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <Input
                        placeholder="Search by shop name, slug, or email..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-10"
                    />
                </div>

                {/* Parent Shops List */}
                {filteredShops.length === 0 ? (
                    <Card>
                        <CardContent className="py-12 text-center">
                            <Store className="h-12 w-12 mx-auto mb-4 text-gray-300" />
                            <p className="text-gray-500">
                                {searchQuery ? "No parent shops match your search" : "No parent shops with sub-agents found"}
                            </p>
                        </CardContent>
                    </Card>
                ) : (
                    <div className="space-y-4">
                        {filteredShops.map((shop) => (
                            <Card key={shop.id} className="overflow-hidden">
                                <CardHeader
                                    className="cursor-pointer hover:bg-gray-50 transition-colors"
                                    onClick={() => toggleExpand(shop.id)}
                                >
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-4">
                                            <div className="p-2 bg-violet-100 rounded-lg">
                                                <Store className="h-5 w-5 text-violet-600" />
                                            </div>
                                            <div>
                                                <CardTitle className="text-lg flex items-center gap-2">
                                                    {shop.shop_name}
                                                    {shop.is_active ? (
                                                        <Badge className="bg-green-100 text-green-700">Active</Badge>
                                                    ) : (
                                                        <Badge className="bg-gray-100 text-gray-600">Inactive</Badge>
                                                    )}
                                                </CardTitle>
                                                <CardDescription className="flex items-center gap-2">
                                                    <span>/{shop.shop_slug}</span>
                                                    <span>•</span>
                                                    <span>{shop.owner_email}</span>
                                                </CardDescription>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-6">
                                            <div className="text-right">
                                                <p className="text-sm text-gray-500">Sub-Agents</p>
                                                <p className="text-lg font-bold text-blue-600">{shop.total_sub_agents}</p>
                                            </div>
                                            <div className="text-right">
                                                <p className="text-sm text-gray-500">Total Earned</p>
                                                <p className="text-lg font-bold text-green-600">GHS {shop.total_earned_from_subagents.toFixed(2)}</p>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={(e) => {
                                                        e.stopPropagation()
                                                        router.push(`/admin/sub-agent-profits/${shop.id}`)
                                                    }}
                                                >
                                                    <Eye className="h-4 w-4 mr-1" />
                                                    Details
                                                </Button>
                                                {expandedShops.has(shop.id) ? (
                                                    <ChevronUp className="h-5 w-5 text-gray-400" />
                                                ) : (
                                                    <ChevronDown className="h-5 w-5 text-gray-400" />
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                </CardHeader>

                                {/* Expanded Sub-Agents List */}
                                {expandedShops.has(shop.id) && shop.sub_agents.length > 0 && (
                                    <CardContent className="border-t bg-gray-50">
                                        <div className="grid gap-3 pt-2">
                                            <p className="text-sm font-medium text-gray-700">Sub-Agents:</p>
                                            {shop.sub_agents.map((subAgent) => (
                                                <div
                                                    key={subAgent.id}
                                                    className="flex items-center justify-between p-3 bg-white rounded-lg border"
                                                >
                                                    <div className="flex items-center gap-3">
                                                        <div className="p-1.5 bg-blue-50 rounded">
                                                            <Users className="h-4 w-4 text-blue-500" />
                                                        </div>
                                                        <div>
                                                            <p className="font-medium text-gray-900">{subAgent.shop_name}</p>
                                                            <p className="text-xs text-gray-500">{subAgent.owner_email}</p>
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center gap-6 text-sm">
                                                        <div className="text-center">
                                                            <p className="text-gray-500">Orders</p>
                                                            <p className="font-semibold">{subAgent.total_orders}</p>
                                                        </div>
                                                        <div className="text-center">
                                                            <p className="text-gray-500">Order Value</p>
                                                            <p className="font-semibold">GHS {subAgent.total_order_value.toFixed(2)}</p>
                                                        </div>
                                                        <div className="text-center">
                                                            <p className="text-gray-500">Profit to Parent</p>
                                                            <p className="font-semibold text-green-600">
                                                                GHS {subAgent.total_profit_to_parent.toFixed(2)}
                                                            </p>
                                                        </div>
                                                        {subAgent.is_active ? (
                                                            <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                                                                Active
                                                            </Badge>
                                                        ) : (
                                                            <Badge variant="outline" className="bg-gray-50 text-gray-500">
                                                                Inactive
                                                            </Badge>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </CardContent>
                                )}

                                {expandedShops.has(shop.id) && shop.sub_agents.length === 0 && (
                                    <CardContent className="border-t bg-gray-50">
                                        <p className="text-sm text-gray-500 text-center py-4">
                                            No sub-agents found for this shop
                                        </p>
                                    </CardContent>
                                )}
                            </Card>
                        ))}
                    </div>
                )}
            </div>
        </AdminLayout>
    )
}
