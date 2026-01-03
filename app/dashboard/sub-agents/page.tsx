"use client"

import { useEffect, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { 
  Users, 
  Plus, 
  Copy, 
  Loader2, 
  Store, 
  TrendingUp, 
  Clock, 
  CheckCircle,
  XCircle,
  ExternalLink,
  Trash2,
  Share2
} from "lucide-react"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"

interface SubAgent {
  id: string
  shop_name: string
  shop_slug: string
  is_active: boolean
  created_at: string
  tier_level: number
  total_orders: number
  total_sales: number
  your_earnings: number
}

interface Invite {
  id: string
  invite_code: string
  email: string | null
  status: string
  created_at: string
  expires_at: string
}

export default function SubAgentsPage() {
  const [loading, setLoading] = useState(true)
  const [subAgents, setSubAgents] = useState<SubAgent[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [shopId, setShopId] = useState<string | null>(null)
  const [stats, setStats] = useState({
    totalSubAgents: 0,
    totalEarningsFromSubAgents: 0,
    activeSubAgents: 0
  })

  // Create invite modal
  const [showInviteModal, setShowInviteModal] = useState(false)
  const [inviteEmail, setInviteEmail] = useState("")
  const [creatingInvite, setCreatingInvite] = useState(false)
  const [newInviteUrl, setNewInviteUrl] = useState<string | null>(null)

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      setLoading(true)
      const { data: { session } } = await supabase.auth.getSession()
      
      if (!session?.access_token) {
        toast.error("Please log in")
        return
      }

      // Get user's shop
      const { data: shop, error: shopError } = await supabase
        .from("user_shops")
        .select("id")
        .eq("user_id", session.user.id)
        .single()

      if (shopError || !shop) {
        toast.error("Shop not found")
        return
      }

      setShopId(shop.id)

      // Get sub-agents (shops with this shop as parent)
      const { data: subAgentShops, error: subAgentError } = await supabase
        .from("user_shops")
        .select("*")
        .eq("parent_shop_id", shop.id)
        .order("created_at", { ascending: false })

      if (!subAgentError && subAgentShops) {
        // For each sub-agent, get their stats
        const subAgentsWithStats = await Promise.all(
          subAgentShops.map(async (sa: any) => {
            // Get their orders count and total sales
            const { data: orders } = await supabase
              .from("shop_orders")
              .select("id, total_price, parent_profit_amount")
              .eq("shop_id", sa.id)
              .eq("payment_status", "completed")

            const totalOrders = orders?.length || 0
            const totalSales = orders?.reduce((sum: number, o: any) => sum + (o.total_price || 0), 0) || 0
            const yourEarnings = orders?.reduce((sum: number, o: any) => sum + (o.parent_profit_amount || 0), 0) || 0

            return {
              id: sa.id,
              shop_name: sa.shop_name,
              shop_slug: sa.shop_slug,
              is_active: sa.is_active,
              created_at: sa.created_at,
              tier_level: sa.tier_level,
              total_orders: totalOrders,
              total_sales: totalSales,
              your_earnings: yourEarnings
            } as SubAgent
          })
        )

        setSubAgents(subAgentsWithStats)

        // Calculate totals
        setStats({
          totalSubAgents: subAgentsWithStats.length,
          activeSubAgents: subAgentsWithStats.filter((sa: SubAgent) => sa.is_active).length,
          totalEarningsFromSubAgents: subAgentsWithStats.reduce((sum: number, sa: SubAgent) => sum + sa.your_earnings, 0)
        })
      }

      // Get invites
      const response = await fetch("/api/shop/invites", {
        headers: { Authorization: `Bearer ${session.access_token}` }
      })
      
      if (response.ok) {
        const data = await response.json()
        setInvites(data.invites || [])
      }
    } catch (error) {
      console.error("Error loading data:", error)
      toast.error("Failed to load data")
    } finally {
      setLoading(false)
    }
  }

  const createInvite = async () => {
    try {
      setCreatingInvite(true)
      const { data: { session } } = await supabase.auth.getSession()
      
      if (!session?.access_token) {
        toast.error("Please log in")
        return
      }

      const response = await fetch("/api/shop/invites", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ email: inviteEmail || null })
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to create invite")
      }

      setNewInviteUrl(data.invite.invite_url)
      toast.success("Invite created!")
      
      // Refresh invites list
      loadData()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create invite")
    } finally {
      setCreatingInvite(false)
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    toast.success("Copied to clipboard!")
  }

  const deleteInvite = async (inviteId: string) => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      
      if (!session?.access_token) return

      const response = await fetch(`/api/shop/invites?id=${inviteId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` }
      })

      if (response.ok) {
        toast.success("Invite deleted")
        setInvites((prev: Invite[]) => prev.filter((i: Invite) => i.id !== inviteId))
      }
    } catch (error) {
      toast.error("Failed to delete invite")
    }
  }

  const getInviteUrl = (code: string) => {
    const baseUrl = typeof window !== "undefined" ? window.location.origin : ""
    return `${baseUrl}/join/${code}`
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
              Sub-Agents
            </h1>
            <p className="text-gray-500 mt-1">Manage your reseller network</p>
          </div>
          <Button 
            onClick={() => { 
              setShowInviteModal(true); 
              setNewInviteUrl(null); 
              setInviteEmail(""); 
            }}
            className="w-full sm:w-auto bg-blue-600 hover:bg-blue-700 text-white"
          >
            <Plus className="w-4 h-4 mr-2" />
            Invite Sub-Agent
          </Button>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-gray-500">Total Sub-Agents</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.totalSubAgents}</div>
              <p className="text-xs text-gray-500">{stats.activeSubAgents} active</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-gray-500">Your Earnings from Sub-Agents</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">
                GHS {(stats.totalEarningsFromSubAgents || 0).toFixed(2)}
              </div>
              <p className="text-xs text-gray-500">From their sales</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-gray-500">Pending Invites</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {invites.filter(i => i.status === "pending").length}
              </div>
              <p className="text-xs text-gray-500">Awaiting signup</p>
            </CardContent>
          </Card>
        </div>

        {/* Sub-Agents List */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="w-5 h-5" />
              Your Sub-Agents
            </CardTitle>
            <CardDescription>Resellers selling under your shop</CardDescription>
          </CardHeader>
          <CardContent>
            {subAgents.length === 0 ? (
              <Alert>
                <Store className="w-4 h-4" />
                <AlertDescription>
                  No sub-agents yet. Click &quot;Invite Sub-Agent&quot; to add resellers to your network.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="space-y-4">
                {subAgents.map((agent) => (
                  <div key={agent.id} className="border rounded-lg p-4">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold">{agent.shop_name}</h3>
                          <Badge variant={agent.is_active ? "default" : "secondary"}>
                            {agent.is_active ? "Active" : "Inactive"}
                          </Badge>
                        </div>
                        <p className="text-sm text-gray-500">
                          /shop/{agent.shop_slug} • Joined {new Date(agent.created_at).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex items-center gap-4 text-sm">
                        <div className="text-center">
                          <div className="font-semibold">{agent.total_orders}</div>
                          <div className="text-gray-500">Orders</div>
                        </div>
                        <div className="text-center">
                          <div className="font-semibold">GHS {(agent.total_sales || 0).toFixed(2)}</div>
                          <div className="text-gray-500">Sales</div>
                        </div>
                        <div className="text-center">
                          <div className="font-semibold text-green-600">GHS {(agent.your_earnings || 0).toFixed(2)}</div>
                          <div className="text-gray-500">Your Earnings</div>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Pending Invites */}
        {invites.filter(i => i.status === "pending").length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="w-5 h-5" />
                Pending Invites
              </CardTitle>
              <CardDescription>Invite links waiting to be used</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {invites
                  .filter(i => i.status === "pending")
                  .map((invite) => (
                    <div key={invite.id} className="flex items-center justify-between border rounded-lg p-3">
                      <div>
                        <code className="text-sm bg-gray-100 px-2 py-1 rounded">
                          {invite.invite_code}
                        </code>
                        {invite.email && (
                          <span className="text-sm text-gray-500 ml-2">({invite.email})</span>
                        )}
                        <p className="text-xs text-gray-500 mt-1">
                          Expires: {new Date(invite.expires_at).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => copyToClipboard(getInviteUrl(invite.invite_code))}
                        >
                          <Copy className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => deleteInvite(invite.id)}
                        >
                          <Trash2 className="w-4 h-4 text-red-500" />
                        </Button>
                      </div>
                    </div>
                  ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Create Invite Modal */}
        <Dialog open={showInviteModal} onOpenChange={setShowInviteModal}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Invite Sub-Agent</DialogTitle>
              <DialogDescription>
                Create an invite link to add a new reseller to your network
              </DialogDescription>
            </DialogHeader>

            {newInviteUrl ? (
              <div className="space-y-4">
                <Alert className="border-green-200 bg-green-50">
                  <CheckCircle className="w-4 h-4 text-green-600" />
                  <AlertDescription className="text-green-800">
                    Invite created! Share this link with your sub-agent.
                  </AlertDescription>
                </Alert>

                <div className="flex items-center gap-2">
                  <Input value={newInviteUrl} readOnly className="text-sm" />
                  <Button onClick={() => copyToClipboard(newInviteUrl)}>
                    <Copy className="w-4 h-4" />
                  </Button>
                </div>

                <DialogFooter>
                  <Button variant="outline" onClick={() => setShowInviteModal(false)}>
                    Done
                  </Button>
                </DialogFooter>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="inviteEmail">Email (optional)</Label>
                  <Input
                    id="inviteEmail"
                    type="email"
                    placeholder="subagent@example.com"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                  />
                  <p className="text-xs text-gray-500">
                    If provided, we&apos;ll show it in your pending invites list.
                  </p>
                </div>

                <Alert>
                  <TrendingUp className="w-4 h-4" />
                  <AlertDescription>
                    Sub-agents will buy data at your selling prices (their wholesale cost).
                    You earn profit on every sale they make!
                  </AlertDescription>
                </Alert>

                <DialogFooter>
                  <Button variant="outline" onClick={() => setShowInviteModal(false)}>
                    Cancel
                  </Button>
                  <Button onClick={createInvite} disabled={creatingInvite}>
                    {creatingInvite ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Creating...
                      </>
                    ) : (
                      <>
                        <Share2 className="w-4 h-4 mr-2" />
                        Create Invite Link
                      </>
                    )}
                  </Button>
                </DialogFooter>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  )
}
