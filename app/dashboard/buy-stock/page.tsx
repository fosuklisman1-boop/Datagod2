"use client"

import { useEffect, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { 
  Wallet, 
  Loader2, 
  AlertCircle,
  ShoppingCart,
  Grid3x3,
  List
} from "lucide-react"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"
import { PhoneNumberModal } from "@/components/phone-number-modal"

interface WholesalePackage {
  id: string
  network: string
  size: string
  parent_price: number
  description?: string
  profit_margin?: number
}

export default function BuyStockPage() {
  const [loading, setLoading] = useState(true)
  const [packages, setPackages] = useState<WholesalePackage[]>([])
  const [walletBalance, setWalletBalance] = useState(0)
  const [selectedNetwork, setSelectedNetwork] = useState<string>("all")
  const [purchasing, setPurchasing] = useState<string | null>(null)
  const [userRole, setUserRole] = useState<string | null>(null)
  const [shopId, setShopId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid")
  
  // Phone modal state
  const [phoneModalOpen, setPhoneModalOpen] = useState(false)
  const [selectedPackageForPurchase, setSelectedPackageForPurchase] = useState<WholesalePackage | null>(null)

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

  const handleBuyClick = (pkg: WholesalePackage) => {
    if (walletBalance < (pkg.parent_price || 0)) {
      toast.error(`Insufficient balance. You need GHS ${(pkg.parent_price || 0).toFixed(2)} but have GHS ${(walletBalance || 0).toFixed(2)}`)
      return
    }
    setSelectedPackageForPurchase(pkg)
    setPhoneModalOpen(true)
  }

  const handlePhoneNumberSubmit = async (phoneNumber: string) => {
    if (!selectedPackageForPurchase) {
      toast.error("Error: Missing package information")
      return
    }

    try {
      setPurchasing(selectedPackageForPurchase.id)
      setPhoneModalOpen(false)

      const { data: { session } } = await supabase.auth.getSession()
      
      if (!session?.access_token) {
        toast.error("Please log in")
        return
      }

      if (!shopId) {
        toast.error("Shop information not found")
        return
      }

      const pkg = selectedPackageForPurchase

      // Create shop order
      const orderResponse = await fetch("/api/shop/orders/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          shop_id: shopId,
          customer_email: session.user?.email || "sub-agent@datagod.com",
          customer_phone: phoneNumber,
          customer_name: `${session.user?.user_metadata?.first_name || ""} ${session.user?.user_metadata?.last_name || ""}`.trim() || "Sub-Agent",
          shop_package_id: pkg.id,
          package_id: pkg.id,
          network: pkg.network,
          volume_gb: pkg.size,
          base_price: pkg.parent_price,
          profit_amount: 0,
          total_price: pkg.parent_price,
        }),
      })

      const orderData = await orderResponse.json()

      if (!orderResponse.ok) {
        console.error("[BUY-STOCK] Order creation failed:", orderData)
        toast.error(orderData.error || `Failed to order ${pkg.network} ${pkg.size}`)
        return
      }

      const orderId = orderData.order?.id
      console.log("[BUY-STOCK] Order created successfully:", orderData)

      // Deduct from wallet
      const debitResponse = await fetch("/api/wallet/debit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          amount: pkg.parent_price,
          orderId: orderId,
          description: `Purchase: ${pkg.network} ${pkg.size}`,
        }),
      })

      const debitData = await debitResponse.json()
      if (!debitResponse.ok) {
        console.error("[BUY-STOCK] Wallet debit failed:", debitData)
        toast.error(debitData.error || "Failed to deduct from wallet")
        return
      }

      // Update local wallet balance
      setWalletBalance(debitData.newBalance || 0)

      toast.success(`Successfully purchased ${pkg.network} ${pkg.size}!`)
      
      // Reset state
      setSelectedPackageForPurchase(null)
    } catch (error) {
      console.error("[BUY-STOCK] Purchase error:", error)
      toast.error(error instanceof Error ? error.message : "Purchase failed")
    } finally {
      setPurchasing(null)
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

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
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
          
          {/* View Toggle */}
          <div className="flex items-center gap-1 ml-auto">
            <Button
              variant={viewMode === "grid" ? "default" : "ghost"}
              size="icon"
              className="h-8 w-8"
              onClick={() => setViewMode("grid")}
            >
              <Grid3x3 className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "list" ? "default" : "ghost"}
              size="icon"
              className="h-8 w-8"
              onClick={() => setViewMode("list")}
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Packages */}
        {filteredPackages.length === 0 ? (
          <Card>
            <CardContent className="p-8 text-center text-gray-500">
              No packages available. Your parent shop needs to add packages to their catalog.
            </CardContent>
          </Card>
        ) : viewMode === "grid" ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filteredPackages.map((pkg) => (
              <Card key={pkg.id} className="relative hover:shadow-lg transition-shadow">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <Badge variant="outline">{pkg.network}</Badge>
                  </div>
                  <CardTitle className="text-lg">{pkg.size}</CardTitle>
                  <CardDescription>{pkg.description || pkg.network}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500 text-sm">Price:</span>
                    <span className="font-bold text-lg text-purple-600">GHS {(pkg.parent_price || 0).toFixed(2)}</span>
                  </div>

                  <Button 
                    className="w-full"
                    onClick={() => handleBuyClick(pkg)}
                    disabled={purchasing === pkg.id || walletBalance < pkg.parent_price}
                  >
                    {purchasing === pkg.id ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Processing...
                      </>
                    ) : walletBalance < pkg.parent_price ? (
                      "Insufficient Balance"
                    ) : (
                      <>
                        <ShoppingCart className="w-4 h-4 mr-2" />
                        Buy Now
                      </>
                    )}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {filteredPackages.map((pkg) => (
              <Card key={pkg.id} className="hover:shadow-md transition-shadow">
                <CardContent className="p-4 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-4 flex-1">
                    <Badge variant="outline">{pkg.network}</Badge>
                    <span className="font-medium">{pkg.size}</span>
                    <span className="text-gray-500 text-sm hidden sm:block">{pkg.description}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="font-bold text-purple-600">GHS {(pkg.parent_price || 0).toFixed(2)}</span>
                    <Button 
                      size="sm"
                      onClick={() => handleBuyClick(pkg)}
                      disabled={purchasing === pkg.id || walletBalance < pkg.parent_price}
                    >
                      {purchasing === pkg.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : walletBalance < pkg.parent_price ? (
                        "Low Balance"
                      ) : (
                        "Buy"
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Phone Number Modal */}
      <PhoneNumberModal
        open={phoneModalOpen}
        onOpenChange={setPhoneModalOpen}
        onSubmit={handlePhoneNumberSubmit}
        packageName={selectedPackageForPurchase 
          ? `${selectedPackageForPurchase.network} ${selectedPackageForPurchase.size} (GHS ${(selectedPackageForPurchase.parent_price || 0).toFixed(2)})`
          : "Data Package"
        }
        network={selectedPackageForPurchase?.network}
      />
    </DashboardLayout>
  )
}
