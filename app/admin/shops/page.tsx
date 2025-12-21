"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CheckCircle, XCircle, Eye } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { adminShopService } from "@/lib/admin-service"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

interface Shop {
  id: string
  shop_name: string
  shop_slug: string
  description?: string
  is_active: boolean
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

  useEffect(() => {
    checkAdminAccess()
  }, [])

  const checkAdminAccess = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const role = user?.user_metadata?.role

      if (role !== "admin") {
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

  if (!isAdmin) return null

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold bg-gradient-to-r from-violet-600 to-purple-600 bg-clip-text text-transparent">Shop Management</h1>
          <p className="text-gray-500 mt-1">Approve or reject shop creation requests</p>
        </div>

        {/* Tabs */}
        <Tabs defaultValue="pending" className="space-y-4">
          <TabsList className="bg-gradient-to-r from-violet-100 to-purple-100 backdrop-blur p-1 rounded-lg">
            <TabsTrigger
              value="pending"
              className="data-[state=active]:bg-white data-[state=active]:shadow-md transition-all"
            >
              Pending ({pendingShops.length})
            </TabsTrigger>
            <TabsTrigger
              value="all"
              className="data-[state=active]:bg-white data-[state=active]:shadow-md transition-all"
            >
              All Shops ({allShops.length})
            </TabsTrigger>
          </TabsList>

          {/* Pending Shops Tab */}
          <TabsContent value="pending" className="space-y-4">
            {pendingShops.length === 0 ? (
              <Card className="bg-gradient-to-br from-green-50/60 to-emerald-50/40 backdrop-blur-xl border border-green-200/40">
                <CardContent className="pt-12 pb-12 text-center">
                  <CheckCircle className="w-12 h-12 text-green-600 mx-auto mb-4" />
                  <p className="text-lg font-semibold text-gray-900">No Pending Approvals</p>
                  <p className="text-gray-500">All shops have been reviewed</p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-4">
                {pendingShops.map((shop) => (
                  <Card key={shop.id} className="border-l-4 border-l-orange-500 bg-gradient-to-br from-orange-50/60 to-yellow-50/40 backdrop-blur-xl border border-orange-200/40 hover:border-orange-300/60 hover:shadow-lg transition-all">
                    <CardContent className="pt-6">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-3 mb-2">
                            <h3 className="text-lg font-bold text-gray-900">{shop.shop_name}</h3>
                            <Badge className="bg-orange-600">Pending</Badge>
                          </div>
                          <p className="text-sm text-gray-600 mb-2">{shop.description || "No description"}</p>
                          <div className="flex gap-4 text-xs text-gray-600">
                            <span>Slug: <code className="font-mono">{shop.shop_slug}</code></span>
                            <span>Created: {new Date(shop.created_at).toLocaleDateString()}</span>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={() => handleViewDetails(shop)}
                            variant="outline"
                            className="text-blue-600 hover:text-blue-700 hover:bg-blue-50"
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
          <TabsContent value="all">
            <Card className="bg-gradient-to-br from-violet-50/60 to-purple-50/40 backdrop-blur-xl border border-violet-200/40">
              <CardHeader>
                <CardTitle>All Shops</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gradient-to-r from-violet-100/60 to-purple-100/60 backdrop-blur border-b border-violet-200/40">
                      <tr>
                        <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Shop Name</th>
                        <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Slug</th>
                        <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Status</th>
                        <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Created</th>
                        <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-violet-100/40">
                      {allShops.map((shop) => (
                        <tr key={shop.id} className="hover:bg-violet-100/30 backdrop-blur transition-colors">
                          <td className="px-6 py-4 font-medium text-gray-900">{shop.shop_name}</td>
                          <td className="px-6 py-4 text-sm text-gray-600"><code className="font-mono">{shop.shop_slug}</code></td>
                          <td className="px-6 py-4">
                            <Badge className={shop.is_active ? "bg-green-600" : "bg-orange-600"}>
                              {shop.is_active ? "Active" : "Pending"}
                            </Badge>
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-600">{new Date(shop.created_at).toLocaleDateString()}</td>
                          <td className="px-6 py-4">
                            <Button
                              size="sm"
                              onClick={() => handleViewDetails(shop)}
                              variant="outline"
                              className="text-violet-600 hover:text-violet-700 hover:bg-violet-50"
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
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{selectedShop?.shop_name}</DialogTitle>
            </DialogHeader>
            {shopDetails && (
              <div className="space-y-6">
                {/* Shop Info */}
                <div>
                  <h3 className="font-semibold mb-3">Shop Information</h3>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-gray-600">Name</p>
                      <p className="font-semibold">{shopDetails.shop.shop_name}</p>
                    </div>
                    <div>
                      <p className="text-gray-600">Slug</p>
                      <p className="font-mono text-sm">{shopDetails.shop.shop_slug}</p>
                    </div>
                    <div>
                      <p className="text-gray-600">Status</p>
                      <Badge className={shopDetails.shop.is_active ? "bg-green-600" : "bg-orange-600"}>
                        {shopDetails.shop.is_active ? "Active" : "Pending"}
                      </Badge>
                    </div>
                    <div>
                      <p className="text-gray-600">Created</p>
                      <p className="font-semibold">{new Date(shopDetails.shop.created_at).toLocaleDateString()}</p>
                    </div>
                  </div>
                </div>

                {/* Orders Stats */}
                <div>
                  <h3 className="font-semibold mb-3">Orders & Revenue</h3>
                  <div className="grid grid-cols-3 gap-4 text-sm">
                    <div className="bg-blue-50 p-3 rounded-lg">
                      <p className="text-gray-600">Total Orders</p>
                      <p className="text-xl font-bold text-blue-600">{shopDetails.orders.length}</p>
                    </div>
                    <div className="bg-emerald-50 p-3 rounded-lg">
                      <p className="text-gray-600">Total Revenue</p>
                      <p className="text-xl font-bold text-emerald-600">GHS {(shopDetails.orders.reduce((sum: number, o: any) => sum + (o.total_price || 0), 0)).toFixed(2)}</p>
                    </div>
                    <div className="bg-purple-50 p-3 rounded-lg">
                      <p className="text-gray-600">Total Profits</p>
                      <p className="text-xl font-bold text-purple-600">GHS {(shopDetails.profits.reduce((sum: number, p: any) => sum + p.profit_amount, 0)).toFixed(2)}</p>
                    </div>
                  </div>
                </div>

                {/* Actions */}
                {!selectedShop?.is_active && (
                  <div className="flex gap-2 border-t pt-4">
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
