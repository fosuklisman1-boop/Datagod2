"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CheckCircle, XCircle, Eye, TrendingDown, ShieldOff, ShieldCheck } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { adminShopService } from "@/lib/admin-service"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

interface Shop {
  id: string
  shop_name: string
  shop_slug: string
  description?: string
  is_active: boolean
  is_blocked?: boolean
  block_reason?: string
  created_at: string
  user_id: string
}

export default function AdminShopsPage() {
  const router = useRouter()
  const [allShops, setAllShops] = useState<Shop[]>([])
  const [pendingShops, setPendingShops] = useState<Shop[]>([])
  const [loading, setLoading] = useState(true)
  const [isAdmin, setIsAdmin] = useState(false)
  const [selectedShop, setSelectedShop] = useState<Shop | null>(null)
  const [showDetailsDialog, setShowDetailsDialog] = useState(false)
  const [shopDetails, setShopDetails] = useState<any>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [blockReason, setBlockReason] = useState("")
  const [blockLoading, setBlockLoading] = useState(false)
  const [rotateLoading, setRotateLoading] = useState(false)

  useEffect(() => {
    checkAdminAccess()
  }, [])

  const checkAdminAccess = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push("/dashboard"); return }

      let isAdminUser = user?.user_metadata?.role === "admin"
      if (!isAdminUser) {
        const { data: userData } = await supabase.from("users").select("role").eq("id", user.id).single()
        isAdminUser = userData?.role === "admin"
      }

      if (!isAdminUser) {
        toast.error("Unauthorized access")
        router.push("/dashboard")
        return
      }

      setIsAdmin(true)
      await loadShops()
    } catch (error) {
      console.error("Error checking admin access:", error)
      router.push("/dashboard")
    }
  }


  const loadShops = async () => {
    try {
      const [allData, pendingData] = await Promise.all([
        adminShopService.getAllShops(),
        adminShopService.getPendingShops(),
      ])
      setAllShops(allData || [])
      setPendingShops(pendingData || [])
    } catch (error) {
      console.error("Error loading shops:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to load shops"
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const handleViewDetails = async (shop: Shop) => {
    try {
      const details = await adminShopService.getShopDetails(shop.id)
      setShopDetails(details)
      setSelectedShop(shop)
      setShowDetailsDialog(true)
    } catch (error) {
      console.error("Error loading shop details:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to load shop details"
      toast.error(errorMessage)
    }
  }

  const handleApprove = async (shopId: string) => {
    if (!confirm("Approve this shop?")) return

    try {
      await adminShopService.approveShop(shopId)
      toast.success("Shop approved successfully")
      await loadShops()
      setShowDetailsDialog(false)
    } catch (error: any) {
      console.error("Error approving shop:", error)
      toast.error(error.message || "Failed to approve shop")
    }
  }

  const handleReject = async (shopId: string) => {
    if (!confirm("Reject this shop?")) return

    try {
      await adminShopService.rejectShop(shopId)
      toast.success("Shop rejected successfully")
      await loadShops()
      setShowDetailsDialog(false)
    } catch (error: any) {
      console.error("Error rejecting shop:", error)
      toast.error(error.message || "Failed to reject shop")
    }
  }

  const handleBlock = async (shopId: string) => {
    if (!blockReason.trim()) {
      toast.error("Please provide a reason for blocking")
      return
    }
    if (!confirm(`Temporarily block this shop? Reason: "${blockReason.trim()}"`)) return

    setBlockLoading(true)
    try {
      await adminShopService.blockShop(shopId, blockReason.trim())
      toast.success("Shop blocked successfully")
      setBlockReason("")
      await loadShops()
      await handleViewDetails(selectedShop!)
    } catch (error: any) {
      toast.error(error.message || "Failed to block shop")
    } finally {
      setBlockLoading(false)
    }
  }

  const handleUnblock = async (shopId: string) => {
    if (!confirm("Unblock this shop? It will become active again.")) return

    setBlockLoading(true)
    try {
      await adminShopService.unblockShop(shopId)
      toast.success("Shop unblocked successfully")
      await loadShops()
      await handleViewDetails(selectedShop!)
    } catch (error: any) {
      toast.error(error.message || "Failed to unblock shop")
    } finally {
      setBlockLoading(false)
    }
  }

  const handleRotateSlug = async (shopId: string, customSlug?: string) => {
    if (!confirm(
      "Rotate this shop's URL? The current /shop link will stop working immediately and any cookies/links tied to the old slug become invalid. Use this to break an attacker's hardcoded URL. You'll need to share the new link with the merchant."
    )) return

    setRotateLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Authentication required")
        return
      }
      const res = await fetch(`/api/dashboard/shops/${shopId}/rotate-slug`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(customSlug ? { newSlug: customSlug } : {}),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data?.error || "Failed to rotate shop URL")
        return
      }
      toast.success(`URL rotated: ${data.oldSlug} → ${data.newSlug}`)
      await loadShops()
      await handleViewDetails(selectedShop!)
    } catch (error: any) {
      toast.error(error.message || "Failed to rotate shop URL")
    } finally {
      setRotateLoading(false)
    }
  }

  if (!isAdmin) return null

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold bg-gradient-to-r from-primary to-primary bg-clip-text text-transparent">Shop Management</h1>
          <p className="text-muted-foreground mt-1">Approve or reject shop creation requests</p>
        </div>

        {/* Tabs */}
        <Tabs defaultValue="pending" className="space-y-4">
          <TabsList className="bg-card backdrop-blur p-1 rounded-lg">
            <TabsTrigger
              value="pending"
              className="data-[state=active]:bg-card data-[state=active]:shadow-md transition-all"
            >
              Pending ({pendingShops.length})
            </TabsTrigger>
            <TabsTrigger
              value="all"
              className="data-[state=active]:bg-card data-[state=active]:shadow-md transition-all"
            >
              All Shops ({allShops.length})
            </TabsTrigger>
          </TabsList>

          {/* Pending Shops Tab */}
          <TabsContent value="pending" className="space-y-4">
            {pendingShops.length === 0 ? (
              <Card className="bg-card backdrop-blur-xl border border-border">
                <CardContent className="pt-12 pb-12 text-center">
                  <CheckCircle className="w-12 h-12 text-green-600 mx-auto mb-4" />
                  <p className="text-lg font-semibold text-foreground">No Pending Approvals</p>
                  <p className="text-muted-foreground">All shops have been reviewed</p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {pendingShops.map((shop) => (
                  <Card key={shop.id} className="border-l-4 border-l-orange-500 bg-card backdrop-blur-xl border border-border hover:border-border hover:shadow-lg transition-all">
                    <CardContent className="pt-6">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-3 mb-2">
                            <h3 className="text-lg font-bold text-foreground">{shop.shop_name}</h3>
                            <Badge className="bg-orange-600">Pending</Badge>
                          </div>
                          <p className="text-sm text-muted-foreground mb-2">{shop.description || "No description"}</p>
                          <div className="flex gap-4 text-xs text-muted-foreground">
                            <span>Slug: <code className="font-mono">{shop.shop_slug}</code></span>
                            <span>Created: {new Date(shop.created_at).toLocaleDateString()}</span>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={() => handleViewDetails(shop)}
                            variant="outline"
                            className="text-primary hover:text-primary hover:bg-primary/5"
                          >
                            <Eye className="w-4 h-4 mr-1" />
                            Details
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => handleApprove(shop.id)}
                            className="bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700"
                          >
                            <CheckCircle className="w-4 h-4 mr-1" />
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => handleReject(shop.id)}
                            className="bg-gradient-to-r from-red-600 to-pink-600 hover:from-red-700 hover:to-pink-700"
                          >
                            <XCircle className="w-4 h-4 mr-1" />
                            Reject
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* All Shops Tab */}
          <TabsContent value="all" className="space-y-4">
            <div className="flex items-center gap-2 max-w-sm">
              <Input 
                placeholder="Search shops by name or slug..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-card/50 backdrop-blur border-border"
              />
            </div>
            <Card className="bg-card backdrop-blur-xl border border-border">
              <CardHeader>
                <CardTitle>All Shops</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="min-w-[600px] w-full text-xs sm:text-sm">
                    <thead className="bg-card backdrop-blur border-b border-border">
                      <tr>
                        <th className="px-6 py-3 text-left text-sm font-semibold text-foreground">Shop Name</th>
                        <th className="px-6 py-3 text-left text-sm font-semibold text-foreground">Slug</th>
                        <th className="px-6 py-3 text-left text-sm font-semibold text-foreground">Status</th>
                        <th className="px-6 py-3 text-left text-sm font-semibold text-foreground">Created</th>
                        <th className="px-6 py-3 text-left text-sm font-semibold text-foreground">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-primary/40">
                      {allShops
                        .filter(shop => 
                          shop.shop_name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          shop.shop_slug.toLowerCase().includes(searchQuery.toLowerCase())
                        )
                        .map((shop) => (
                        <tr key={shop.id} className="hover:bg-primary/30 backdrop-blur transition-colors">
                          <td className="px-6 py-4 font-medium text-foreground">{shop.shop_name}</td>
                          <td className="px-6 py-4 text-sm text-muted-foreground"><code className="font-mono">{shop.shop_slug}</code></td>
                          <td className="px-6 py-4">
                            {shop.is_blocked ? (
                              <Badge className="bg-red-600">Blocked</Badge>
                            ) : shop.is_active ? (
                              <Badge className="bg-green-600">Active</Badge>
                            ) : (
                              <Badge className="bg-orange-600">Pending</Badge>
                            )}
                          </td>
                          <td className="px-6 py-4 text-sm text-muted-foreground">{new Date(shop.created_at).toLocaleDateString()}</td>
                          <td className="px-6 py-4">
                            <Button
                              size="sm"
                              onClick={() => handleViewDetails(shop)}
                              variant="outline"
                              className="text-primary hover:text-primary hover:bg-primary"
                            >
                              <Eye className="w-4 h-4" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Shop Details Dialog */}
        <Dialog open={showDetailsDialog} onOpenChange={setShowDetailsDialog}>
          <DialogContent className="max-w-2xl w-[95vw] sm:w-full max-h-[90vh] overflow-y-auto p-4 sm:p-6">
            <DialogHeader>
              <DialogTitle className="pr-8">{selectedShop?.shop_name}</DialogTitle>
            </DialogHeader>
            {shopDetails && (
              <div className="space-y-6">
                {/* Shop Info */}
                <div>
                  <h3 className="font-semibold mb-3">Shop Information</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground">Name</p>
                      <p className="font-semibold">{shopDetails.shop.shop_name}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Slug (Shop URL)</p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-mono text-sm break-all">{shopDetails.shop.shop_slug}</p>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={rotateLoading}
                          onClick={() => handleRotateSlug(selectedShop!.id)}
                          className="h-7 px-2 text-xs border-border text-amber-700 hover:bg-amber-50"
                          title="Generate a new URL and break the old one (anti-attack)"
                        >
                          {rotateLoading ? "Rotating…" : "🔄 Rotate URL"}
                        </Button>
                      </div>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Status</p>
                      {shopDetails.shop.is_blocked ? (
                        <Badge className="bg-red-600">Blocked</Badge>
                      ) : shopDetails.shop.is_active ? (
                        <Badge className="bg-green-600">Active</Badge>
                      ) : (
                        <Badge className="bg-orange-600">Pending</Badge>
                      )}
                    </div>
                    <div>
                      <p className="text-muted-foreground">Created</p>
                      <p className="font-semibold">{new Date(shopDetails.shop.created_at).toLocaleDateString()}</p>
                    </div>
                  </div>
                </div>

                {/* Orders Stats */}
                <div>
                  <h3 className="font-semibold mb-3">Orders & Revenue</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
                    <div className="bg-primary/5 p-3 rounded-lg text-center">
                      <p className="text-muted-foreground text-[10px] uppercase font-bold tracking-wider mb-1">Total Orders</p>
                      <p className="text-xl font-bold text-primary font-mono italic">{shopDetails.orders.length}</p>
                    </div>
                    <div className="bg-emerald-50 p-3 rounded-lg text-center hover:shadow-inner transition-all border border-border">
                      <p className="text-muted-foreground text-[10px] uppercase font-bold tracking-wider mb-1">Total Revenue</p>
                      <p className="text-xl font-bold text-emerald-600 font-mono tracking-tighter tabular-nums">GHS {(shopDetails.orders.reduce((sum: number, o: any) => sum + (o.total_price || 0), 0)).toFixed(2)}</p>
                    </div>
                    <div className="bg-primary p-3 rounded-lg text-center ring-1 ring-primary ring-offset-2">
                      <p className="text-muted-foreground text-[10px] uppercase font-bold tracking-wider mb-1">Profit Balance</p>
                      <p className="text-xl font-bold text-primary font-mono tracking-tighter tabular-nums underline decoration-primary decoration-wavy underline-offset-4">GHS {Number(shopDetails.available_balance || 0).toFixed(2)}</p>
                    </div>
                  </div>
                </div>

                {/* Manual Balance Adjustment */}
                <div className="p-4 rounded-xl bg-card border border-border shadow-sm transition-all duration-300 hover:shadow-md group">
                  <h3 className="text-sm font-bold text-primary mb-4 flex items-center gap-2">
                    <div className="p-1 rounded bg-primary group-hover:bg-primary transition-colors">
                      <TrendingDown className="w-3.5 h-3.5 text-primary" />
                    </div>
                    Manual Balance Adjustment
                  </h3>
                  <div className="grid gap-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-bold text-primary uppercase tracking-widest pl-1">Amount (GHS)</label>
                        <Input
                          type="number"
                          placeholder="0.00"
                          className="font-mono h-9 border-border focus:border-border focus:ring-primary transition-all bg-card/50"
                          id="manual-adj-amount"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-bold text-primary uppercase tracking-widest pl-1">Description / Reason</label>
                        <Input
                          placeholder="Reason for adjustment..."
                          className="h-9 border-border focus:border-border focus:ring-primary transition-all bg-card/50"
                          id="manual-adj-notes"
                        />
                      </div>
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2.5">
                      <Button
                        size="sm"
                        className="flex-1 bg-primary hover:bg-primary text-white shadow-sm shadow-primary h-9 font-bold tracking-tight transition-all active:scale-[0.98]"
                        onClick={async () => {
                          const amount = (document.getElementById("manual-adj-amount") as HTMLInputElement).value
                          const notes = (document.getElementById("manual-adj-notes") as HTMLInputElement).value
                          if (!amount || Number(amount) <= 0) { toast.error("Please enter a valid amount"); return }
                          if (!confirm(`Credit account with GHS ${amount}?`)) return
                          
                          try {
                            const res = await adminShopService.manualBalanceAdjustment(selectedShop!.id, Number(amount), "credit", notes)
                            toast.success("Balance credited successfully")
                            handleViewDetails(selectedShop!) // Refresh details
                            ;(document.getElementById("manual-adj-amount") as HTMLInputElement).value = ""
                            ;(document.getElementById("manual-adj-notes") as HTMLInputElement).value = ""
                          } catch (err: any) {
                            toast.error(err.message || "Failed to adjust balance")
                          }
                        }}
                      >
                        Credit Account
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1 border-border text-rose-600 hover:bg-rose-50 hover:border-border h-9 font-bold tracking-tight transition-all active:scale-[0.98]"
                        onClick={async () => {
                          const amount = (document.getElementById("manual-adj-amount") as HTMLInputElement).value
                          const notes = (document.getElementById("manual-adj-notes") as HTMLInputElement).value
                          if (!amount || Number(amount) <= 0) { toast.error("Please enter a valid amount"); return }
                          if (!confirm(`Debit account by GHS ${amount}?`)) return
                          
                          try {
                            const res = await adminShopService.manualBalanceAdjustment(selectedShop!.id, Number(amount), "debit", notes)
                            toast.success("Balance debited successfully")
                            handleViewDetails(selectedShop!) // Refresh details
                            ;(document.getElementById("manual-adj-amount") as HTMLInputElement).value = ""
                            ;(document.getElementById("manual-adj-notes") as HTMLInputElement).value = ""
                          } catch (err: any) {
                            toast.error(err.message || "Failed to adjust balance")
                          }
                        }}
                      >
                        Debit Account
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Block / Unblock — only for active shops */}
                {selectedShop?.is_active && (
                  <div className="p-4 rounded-xl bg-card border border-border shadow-sm space-y-3">
                    <h3 className="text-sm font-bold text-red-900 flex items-center gap-2">
                      <ShieldOff className="w-3.5 h-3.5 text-red-600" />
                      Temporary Block
                    </h3>
                    {shopDetails?.shop.is_blocked ? (
                      <div className="space-y-2">
                        <p className="text-xs text-red-700">
                          <span className="font-semibold">Current reason:</span> {shopDetails.shop.block_reason || "—"}
                        </p>
                        <Button
                          size="sm"
                          disabled={blockLoading}
                          onClick={() => handleUnblock(selectedShop.id)}
                          className="bg-green-600 hover:bg-green-700 text-white w-full"
                        >
                          <ShieldCheck className="w-4 h-4 mr-2" />
                          Unblock Shop
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Textarea
                          placeholder="Reason for blocking (required)..."
                          value={blockReason}
                          onChange={(e) => setBlockReason(e.target.value)}
                          className="text-sm border-border focus:border-border resize-none h-20"
                        />
                        <Button
                          size="sm"
                          disabled={blockLoading || !blockReason.trim()}
                          onClick={() => handleBlock(selectedShop.id)}
                          className="bg-red-600 hover:bg-red-700 text-white w-full"
                        >
                          <ShieldOff className="w-4 h-4 mr-2" />
                          Block Shop
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                {/* Actions */}
                {!selectedShop?.is_active && (
                  <div className="flex flex-col sm:flex-row gap-2 border-t pt-4">
                    <Button
                      onClick={() => handleApprove(selectedShop!.id)}
                      className="flex-1 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700"
                    >
                      <CheckCircle className="w-4 h-4 mr-2" />
                      Approve Shop
                    </Button>
                    <Button
                      onClick={() => handleReject(selectedShop!.id)}
                      className="flex-1 bg-gradient-to-r from-red-600 to-pink-600 hover:from-red-700 hover:to-pink-700"
                    >
                      <XCircle className="w-4 h-4 mr-2" />
                      Reject Shop
                    </Button>
                  </div>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  )
}
