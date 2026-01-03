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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { 
  ShoppingBag, 
  Wallet, 
  Package, 
  Loader2, 
  AlertCircle,
  CheckCircle,
  Minus,
  Plus,
  CreditCard
} from "lucide-react"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"

interface WholesalePackage {
  id: string
  network: string
  size: string
  parent_price: number    // Sub-agent's wholesale cost (admin price + parent's margin)
  description?: string
  profit_margin?: number
  _parent_wholesale_margin?: number
  _original_admin_price?: number
}

export default function BuyStockPage() {
  const [loading, setLoading] = useState(true)
  const [packages, setPackages] = useState<WholesalePackage[]>([])
  const [walletBalance, setWalletBalance] = useState(0)
  const [selectedNetwork, setSelectedNetwork] = useState<string>("all")
  const [cart, setCart] = useState<{ [packageId: string]: number }>({})
  const [purchasing, setPurchasing] = useState(false)
  const [showConfirmModal, setShowConfirmModal] = useState(false)
  const [userRole, setUserRole] = useState<string | null>(null)
  const [shopId, setShopId] = useState<string | null>(null)

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      setLoading(true)
      const { data: { session } } = await supabase.auth.getSession()
      
      if (!session?.user) {
        toast.error("Please log in")
        return
      }

      // Get user role
      const { data: userData } = await supabase
        .from("users")
        .select("role")
        .eq("id", session.user.id)
        .single()

      setUserRole(userData?.role || null)

      // Get user's shop with parent info
      const { data: shop, error: shopError } = await supabase
        .from("user_shops")
        .select("id, parent_shop_id")
        .eq("user_id", session.user.id)
        .single()

      if (shopError || !shop) {
        toast.error("Shop not found")
        return
      }

      setShopId(shop.id)

      // Get wallet balance
      try {
        const { data: wallet } = await supabase
          .from("wallets")
          .select("balance")
          .eq("user_id", session.user.id)
          .single()
        setWalletBalance(wallet?.balance ?? 0)
      } catch (walletError) {
        // Wallet endpoint may return 406 for non-wallet users, default to 0
        setWalletBalance(0)
      }

      // Get packages from parent's sub_agent_catalog via API
      const token = session.access_token
      if (!token) {
        toast.error("Authentication error")
        return
      }

      const response = await fetch("/api/shop/parent-packages", {
        headers: { "Authorization": `Bearer ${token}` }
      })
      
      if (!response.ok) {
        console.error("API Error:", response.status, response.statusText)
        toast.error(`Failed to fetch packages: ${response.statusText}`)
        return
      }
      
      const data = await response.json()
      console.log("[BUY-STOCK] Fetched data:", data)

      if (!data.is_sub_agent) {
        toast.error("This page is for sub-agents only")
        return
      }

      if (data.packages && data.packages.length > 0) {
        console.log("[BUY-STOCK] Loaded packages:", data.packages)
        setPackages(data.packages)
      } else {
        console.log("[BUY-STOCK] No packages available")
        toast.info("No packages available. Your parent shop needs to add packages to their catalog.")
      }
    } catch (error) {
      console.error("Error loading data:", error)
      toast.error("Failed to load data")
    } finally {
      setLoading(false)
    }
  }

  const networks = [...new Set(packages.map(p => p.network))]

  const filteredPackages = selectedNetwork === "all" 
    ? packages 
    : packages.filter(p => p.network === selectedNetwork)

  const updateCart = (packageId: string, delta: number) => {
    setCart(prev => {
      const current = prev[packageId] || 0
      const newQty = Math.max(0, current + delta)
      if (newQty === 0) {
        const { [packageId]: _, ...rest } = prev
        return rest
      }
      return { ...prev, [packageId]: newQty }
    })
  }

  const getCartTotal = () => {
    return Object.entries(cart).reduce((total, [packageId, qty]) => {
      const pkg = packages.find(p => p.id === packageId)
      return total + (pkg?.parent_price || 0) * qty
    }, 0)
  }

  const getCartItemCount = () => {
    return Object.values(cart).reduce((sum, qty) => sum + qty, 0)
  }

  const handlePurchase = async () => {
    try {
      setPurchasing(true)
      const { data: { session } } = await supabase.auth.getSession()
      
      if (!session?.access_token) {
        toast.error("Please log in")
        return
      }

      // TODO: Implement actual purchase API
      // For now, show placeholder
      toast.info("Purchase functionality coming soon!")
      
      // Clear cart and close modal
      setCart({})
      setShowConfirmModal(false)
    } catch (error) {
      toast.error("Purchase failed")
    } finally {
      setPurchasing(false)
    }
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

  if (userRole !== "sub_agent") {
    return (
      <DashboardLayout>
        <Alert variant="destructive">
          <AlertCircle className="w-4 h-4" />
          <AlertDescription>
            This page is for sub-agents only. Regular shop owners order directly from admin.
          </AlertDescription>
        </Alert>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold bg-gradient-to-r from-purple-600 to-pink-600 bg-clip-text text-transparent">
              Buy Stock
            </h1>
            <p className="text-gray-500 mt-1">Purchase data packages at wholesale prices</p>
          </div>
          
          {/* Wallet Balance */}
          <Card className="w-fit">
            <CardContent className="p-4 flex items-center gap-3">
              <Wallet className="w-5 h-5 text-green-600" />
              <div>
                <p className="text-xs text-gray-500">Wallet Balance</p>
                <p className="text-lg font-bold text-green-600">GHS {(walletBalance || 0).toFixed(2)}</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filter */}
        <div className="flex items-center gap-4">
          <Label>Network:</Label>
          <Select value={selectedNetwork} onValueChange={setSelectedNetwork}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="All Networks" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Networks</SelectItem>
              {networks.map(network => (
                <SelectItem key={network} value={network}>{network}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Packages Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredPackages.map((pkg) => (
            <Card key={pkg.id} className="relative">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <Badge variant="outline">{pkg.network}</Badge>
                </div>
                <CardTitle className="text-lg">{pkg.size}</CardTitle>
                <CardDescription>{pkg.description || pkg.network}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">Wholesale Price:</span>
                  <span className="font-semibold text-purple-600">GHS {(pkg.parent_price || 0).toFixed(2)}</span>
                </div>

                {/* Quantity Controls */}
                <div className="flex items-center justify-between pt-2 border-t">
                  <span className="text-sm font-medium">Quantity:</span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => updateCart(pkg.id, -1)}
                      disabled={!cart[pkg.id]}
                    >
                      <Minus className="w-4 h-4" />
                    </Button>
                    <span className="w-8 text-center font-medium">{cart[pkg.id] || 0}</span>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => updateCart(pkg.id, 1)}
                    >
                      <Plus className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Cart Summary (Fixed at bottom) */}
        {getCartItemCount() > 0 && (
          <Card className="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-96 shadow-lg border-2 border-purple-200 z-50">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="font-semibold">Cart ({getCartItemCount()} items)</span>
                <span className="text-lg font-bold">GHS {getCartTotal().toFixed(2)}</span>
              </div>
              
              {getCartTotal() > (walletBalance || 0) ? (
                <Alert variant="destructive" className="mb-3">
                  <AlertCircle className="w-4 h-4" />
                  <AlertDescription className="text-xs">
                    Insufficient balance. Add GHS {(getCartTotal() - (walletBalance || 0)).toFixed(2)} to wallet.
                  </AlertDescription>
                </Alert>
              ) : null}

              <Button 
                className="w-full" 
                disabled={getCartTotal() > (walletBalance || 0)}
                onClick={() => setShowConfirmModal(true)}
              >
                <ShoppingBag className="w-4 h-4 mr-2" />
                Checkout
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Confirm Modal */}
        <Dialog open={showConfirmModal} onOpenChange={setShowConfirmModal}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Confirm Purchase</DialogTitle>
              <DialogDescription>
                Review your order before confirming
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {/* Order Summary */}
              <div className="border rounded-lg p-4 space-y-2 max-h-64 overflow-y-auto">
                {Object.entries(cart).map(([packageId, qty]) => {
                  const pkg = packages.find(p => p.id === packageId)
                  if (!pkg) return null
                  return (
                    <div key={packageId} className="flex items-center justify-between text-sm">
                      <span>{pkg.network} - {pkg.size} x{qty}</span>
                      <span className="font-medium">GHS {((pkg.parent_price || 0) * qty).toFixed(2)}</span>
                    </div>
                  )
                })}
              </div>

              <div className="border-t pt-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-gray-500">Subtotal:</span>
                  <span className="font-semibold">GHS {getCartTotal().toFixed(2)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500">Wallet Balance:</span>
                  <span>GHS {(walletBalance || 0).toFixed(2)}</span>
                </div>
                <div className="flex items-center justify-between font-bold border-t pt-2">
                  <span>After Purchase:</span>
                  <span>GHS {((walletBalance || 0) - getCartTotal()).toFixed(2)}</span>
                </div>
              </div>

              <Alert>
                <CreditCard className="w-4 h-4" />
                <AlertDescription>
                  Amount will be deducted from your wallet balance.
                </AlertDescription>
              </Alert>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setShowConfirmModal(false)}>
                Cancel
              </Button>
              <Button onClick={handlePurchase} disabled={purchasing}>
                {purchasing ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    <CheckCircle className="w-4 h-4 mr-2" />
                    Confirm Purchase
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  )
}
