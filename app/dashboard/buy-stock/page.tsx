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
  package_name: string
  package_type: string
  data_amount: string
  wholesale_price: number  // Price you pay (parent's selling price)
  selling_price: number    // Your selling price to customers
  network: string
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
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", session.user.id)
        .single()

      setUserRole(profile?.role || null)

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

      if (!shop.parent_shop_id) {
        // Not a sub-agent, shouldn't be on this page
        toast.error("This page is for sub-agents only")
        return
      }

      // Get wallet balance
      const { data: wallet } = await supabase
        .from("wallets")
        .select("balance")
        .eq("user_id", session.user.id)
        .single()

      setWalletBalance(wallet?.balance || 0)

      // Get packages from parent shop (parent's selling price = your wholesale cost)
      const { data: parentPackages, error: pkgError } = await supabase
        .from("shop_packages")
        .select(`
          id,
          package_name,
          package_type,
          data_amount,
          selling_price,
          network
        `)
        .eq("shop_id", shop.parent_shop_id)
        .eq("is_active", true)
        .order("network")
        .order("selling_price", { ascending: true })

      if (!pkgError && parentPackages) {
        // Map parent's selling price to your wholesale price
        // Your selling price would be from your own shop_packages
        const { data: myPackages } = await supabase
          .from("shop_packages")
          .select("id, package_name, selling_price")
          .eq("shop_id", shop.id)

        const myPriceMap = new Map(myPackages?.map(p => [p.package_name, p.selling_price]) || [])

        const wholesalePackages = parentPackages.map(pkg => ({
          id: pkg.id,
          package_name: pkg.package_name,
          package_type: pkg.package_type,
          data_amount: pkg.data_amount,
          wholesale_price: pkg.selling_price,  // Parent's price = your cost
          selling_price: myPriceMap.get(pkg.package_name) || pkg.selling_price,  // Your price
          network: pkg.network
        }))

        setPackages(wholesalePackages)
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
      return total + (pkg?.wholesale_price || 0) * qty
    }, 0)
  }

  const getCartItemCount = () => {
    return Object.values(cart).reduce((sum, qty) => sum + qty, 0)
  }

  const getPotentialProfit = () => {
    return Object.entries(cart).reduce((total, [packageId, qty]) => {
      const pkg = packages.find(p => p.id === packageId)
      if (!pkg) return total
      const profit = (pkg.selling_price - pkg.wholesale_price) * qty
      return total + profit
    }, 0)
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
                <p className="text-lg font-bold text-green-600">GHS {walletBalance.toFixed(2)}</p>
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
                  <Badge className="bg-green-100 text-green-800">
                    Profit: GHS {(pkg.selling_price - pkg.wholesale_price).toFixed(2)}
                  </Badge>
                </div>
                <CardTitle className="text-lg">{pkg.package_name}</CardTitle>
                <CardDescription>{pkg.data_amount}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">Your Cost:</span>
                  <span className="font-semibold text-purple-600">GHS {pkg.wholesale_price.toFixed(2)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">Your Selling Price:</span>
                  <span className="font-medium">GHS {pkg.selling_price.toFixed(2)}</span>
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
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold">Cart ({getCartItemCount()} items)</span>
                <span className="text-lg font-bold">GHS {getCartTotal().toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between text-sm text-green-600 mb-3">
                <span>Potential Profit:</span>
                <span className="font-medium">GHS {getPotentialProfit().toFixed(2)}</span>
              </div>
              
              {getCartTotal() > walletBalance ? (
                <Alert variant="destructive" className="mb-3">
                  <AlertCircle className="w-4 h-4" />
                  <AlertDescription className="text-xs">
                    Insufficient balance. Add GHS {(getCartTotal() - walletBalance).toFixed(2)} to wallet.
                  </AlertDescription>
                </Alert>
              ) : null}

              <Button 
                className="w-full" 
                disabled={getCartTotal() > walletBalance}
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
                      <span>{pkg.package_name} x{qty}</span>
                      <span className="font-medium">GHS {(pkg.wholesale_price * qty).toFixed(2)}</span>
                    </div>
                  )
                })}
              </div>

              <div className="border-t pt-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-gray-500">Subtotal:</span>
                  <span className="font-semibold">GHS {getCartTotal().toFixed(2)}</span>
                </div>
                <div className="flex items-center justify-between text-green-600">
                  <span>Potential Profit:</span>
                  <span className="font-medium">GHS {getPotentialProfit().toFixed(2)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500">Wallet Balance:</span>
                  <span>GHS {walletBalance.toFixed(2)}</span>
                </div>
                <div className="flex items-center justify-between font-bold border-t pt-2">
                  <span>After Purchase:</span>
                  <span>GHS {(walletBalance - getCartTotal()).toFixed(2)}</span>
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
