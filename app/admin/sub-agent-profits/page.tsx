"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useAdminProtected } from "@/hooks/use-admin"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
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
    const { isAdmin, loading: adminLoading } = useAdminProtected()
    const router = useRouter()
    const [parentShops, setParentShops] = useState<ParentShop[]>([])
    const [loading, setLoading] = useState(true)
    const [searchQuery, setSearchQuery] = useState("")
    const [expandedShops, setExpandedShops] = useState<Set<string>>(new Set())

    useEffect(() => {
        if (!adminLoading && isAdmin) {
            loadData()
        }
    }, [isAdmin, adminLoading])

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

    if (adminLoading || loading) {
        return (
            <DashboardLayout>
                <div className="flex items-center justify-center min-h-[400px]">
                    <Loader2 className="w-8 h-8 animate-spin text-primary" />
                </div>
            </DashboardLayout>
        )
    }

    return (
        <DashboardLayout>
            <div className="space-y-6">
                {/* Header */}
                <div>
                    <h1 className="text-3xl font-bold text-foreground">Sub-Agent Profits</h1>
                    <p className="text-muted-foreground mt-1">
                        View parent shops and the profits they earn from their sub-agents
                    </p>
                </div>

                {/* Stats Cards */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    <Card className="bg-card border-border">
                        <CardContent className="pt-6">
                            <div className="flex items-center gap-4">
                                <div className="p-3 bg-primary rounded-lg">
                                    <Store className="h-6 w-6 text-primary" />
                                </div>
                                <div>
                                    <p className="text-sm text-muted-foreground">Parent Shops</p>
                                    <p className="text-2xl font-bold text-primary">{totalParentShops}</p>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="bg-card border-primary/20">
                        <CardContent className="pt-6">
                            <div className="flex items-center gap-4">
                                <div className="p-3 bg-primary/10 rounded-lg">
                                    <Users className="h-6 w-6 text-primary" />
                                </div>
                                <div>
                                    <p className="text-sm text-muted-foreground">Total Sub-Agents</p>
                                    <p className="text-2xl font-bold text-primary">{totalSubAgents}</p>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="bg-card border-border">
                        <CardContent className="pt-6">
                            <div className="flex items-center gap-4">
                                <div className="p-3 bg-success/15 rounded-lg">
                                    <DollarSign className="h-6 w-6 text-success" />
                                </div>
                                <div>
                                    <p className="text-sm text-muted-foreground">Total Earned</p>
                                    <p className="text-2xl font-bold text-success">GHS {totalEarned.toFixed(2)}</p>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="bg-card border-border">
                        <CardContent className="pt-6">
                            <div className="flex items-center gap-4">
                                <div className="p-3 bg-warning/15 rounded-lg">
                                    <TrendingUp className="h-6 w-6 text-warning" />
                                </div>
                                <div>
                                    <p className="text-sm text-muted-foreground">Sub-Agent Orders</p>
                                    <p className="text-2xl font-bold text-warning">{totalOrders}</p>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </div>

                {/* Search */}
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
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
                            <Store className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                            <p className="text-muted-foreground">
                                {searchQuery ? "No parent shops match your search" : "No parent shops with sub-agents found"}
                            </p>
                        </CardContent>
                    </Card>
                ) : (
                    <div className="space-y-4">
                        {filteredShops.map((shop) => (
                            <Card key={shop.id} className="overflow-hidden">
                                <CardHeader
                                    className="cursor-pointer hover:bg-accent transition-colors"
                                    onClick={() => toggleExpand(shop.id)}
                                >
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-4">
                                            <div className="p-2 bg-primary rounded-lg">
                                                <Store className="h-5 w-5 text-primary" />
                                            </div>
                                            <div>
                                                <CardTitle className="text-lg flex items-center gap-2">
                                                    {shop.shop_name}
                                                    {shop.is_active ? (
                                                        <Badge className="bg-success/15 text-success">Active</Badge>
                                                    ) : (
                                                        <Badge className="bg-muted text-muted-foreground">Inactive</Badge>
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
                                                <p className="text-sm text-muted-foreground">Sub-Agents</p>
                                                <p className="text-lg font-bold text-primary">{shop.total_sub_agents}</p>
                                            </div>
                                            <div className="text-right">
                                                <p className="text-sm text-muted-foreground">Total Earned</p>
                                                <p className="text-lg font-bold text-success">GHS {shop.total_earned_from_subagents.toFixed(2)}</p>
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
                                                    <ChevronUp className="h-5 w-5 text-muted-foreground" />
                                                ) : (
                                                    <ChevronDown className="h-5 w-5 text-muted-foreground" />
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                </CardHeader>

                                {/* Expanded Sub-Agents List */}
                                {expandedShops.has(shop.id) && shop.sub_agents.length > 0 && (
                                    <CardContent className="border-t bg-muted/40">
                                        <div className="grid gap-3 pt-2">
                                            <p className="text-sm font-medium text-foreground">Sub-Agents:</p>
                                            {shop.sub_agents.map((subAgent) => (
                                                <div
                                                    key={subAgent.id}
                                                    className="flex items-center justify-between p-3 bg-card rounded-lg border"
                                                >
                                                    <div className="flex items-center gap-3">
                                                        <div className="p-1.5 bg-primary/5 rounded">
                                                            <Users className="h-4 w-4 text-primary" />
                                                        </div>
                                                        <div>
                                                            <p className="font-medium text-foreground">{subAgent.shop_name}</p>
                                                            <p className="text-xs text-muted-foreground">{subAgent.owner_email}</p>
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center gap-6 text-sm">
                                                        <div className="text-center">
                                                            <p className="text-muted-foreground">Orders</p>
                                                            <p className="font-semibold">{subAgent.total_orders}</p>
                                                        </div>
                                                        <div className="text-center">
                                                            <p className="text-muted-foreground">Order Value</p>
                                                            <p className="font-semibold">GHS {subAgent.total_order_value.toFixed(2)}</p>
                                                        </div>
                                                        <div className="text-center">
                                                            <p className="text-muted-foreground">Profit to Parent</p>
                                                            <p className="font-semibold text-success">
                                                                GHS {subAgent.total_profit_to_parent.toFixed(2)}
                                                            </p>
                                                        </div>
                                                        {subAgent.is_active ? (
                                                            <Badge variant="outline" className="bg-success/10 text-success border-success/30">
                                                                Active
                                                            </Badge>
                                                        ) : (
                                                            <Badge variant="outline" className="bg-muted/40 text-muted-foreground">
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
                                    <CardContent className="border-t bg-muted/40">
                                        <p className="text-sm text-muted-foreground text-center py-4">
                                            No sub-agents found for this shop
                                        </p>
                                    </CardContent>
                                )}
                            </Card>
                        ))}
                    </div>
                )}
            </div>
        </DashboardLayout>
    )
}
