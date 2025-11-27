"use client"

import { useEffect, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { shopService, shopPackageService, shopOrderService, networkLogoService } from "@/lib/shop-service"
import { supabase } from "@/lib/supabase"
import { AlertCircle, Store, ShoppingCart, ArrowRight, Zap } from "lucide-react"
import { toast } from "sonner"

export default function ShopStorefront() {
  const params = useParams()
  const router = useRouter()
  const shopSlug = params.slug as string

  const [shop, setShop] = useState<any>(null)
  const [packages, setPackages] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedPackage, setSelectedPackage] = useState<any>(null)
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [selectedNetwork, setSelectedNetwork] = useState<string | null>(null)
  const [networkLogos, setNetworkLogos] = useState<Record<string, string>>({})
  const [orderData, setOrderData] = useState({
    customer_name: "",
    customer_email: "",
    customer_phone: "",
  })
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    loadShopData()
    loadNetworkLogos()
  }, [shopSlug])

  const loadShopData = async () => {
    try {
      setLoading(true)
      const shopData = await shopService.getShopBySlug(shopSlug)
      
      if (!shopData) {
        toast.error("Shop not found")
        return
      }

      setShop(shopData)

      // Get available packages using the shop service
      try {
        const shopPkgs = await shopPackageService.getAvailableShopPackages(shopData.shop_slug)
        if (shopPkgs) {
          setPackages(shopPkgs)
        }
      } catch (pkgError: any) {
        console.error("Error loading packages:", pkgError)
        setPackages([])
      }
    } catch (error) {
      console.error("Error loading shop:", error)
      toast.error("Failed to load shop")
    } finally {
      setLoading(false)
    }
  }

  const loadNetworkLogos = async () => {
    try {
      const logos = await networkLogoService.getLogosAsObject()
      setNetworkLogos(logos)
    } catch (error) {
      console.error("Error loading network logos:", error)
      // Fallback to default logos if database fetch fails
    }
  }

  const handleBuyNow = (pkg: any) => {
    setSelectedPackage(pkg)
    setCheckoutOpen(true)
  }

  const getNetworkLogo = (network: string): string => {
    // Try exact match first
    if (networkLogos[network]) {
      return networkLogos[network]
    }
    
    // Try normalized version (capitalize first letter)
    const normalized = network.charAt(0).toUpperCase() + network.slice(1).toLowerCase()
    if (networkLogos[normalized]) {
      return networkLogos[normalized]
    }

    // Return empty string if not found (will show broken image, forcing database fetch)
    return ""
  }

  const validatePhoneNumber = (phone: string): boolean => {
    // Remove all non-digit characters
    const cleaned = phone.replace(/\D/g, "")
    
    // Normalize: if 9 digits, prepend 0
    let normalized = cleaned
    if (cleaned.length === 9) {
      normalized = "0" + cleaned
    }

    // Check if it's 10 digits and starts with 0
    if (normalized.length !== 10 || !normalized.startsWith("0")) {
      return false
    }

    // Check third digit for network-specific validation
    const thirdDigit = normalized[2]
    return ["2", "5"].includes(thirdDigit)
  }

  const handleSubmitOrder = async () => {
    if (!orderData.customer_name.trim()) {
      toast.error("Please enter your name")
      return
    }

    if (!orderData.customer_email.trim()) {
      toast.error("Please enter your email")
      return
    }

    if (!validatePhoneNumber(orderData.customer_phone)) {
      toast.error("Please enter a valid phone number (starting with 02 or 05)")
      return
    }

    try {
      setSubmitting(true)

      // Normalize phone number
      const cleaned = orderData.customer_phone.replace(/\D/g, "")
      const normalizedPhone = cleaned.length === 9 ? "0" + cleaned : cleaned

      const pkg = selectedPackage.packages
      const basePrice = pkg.price
      const profitAmount = selectedPackage.profit_margin
      const totalPrice = basePrice + profitAmount
      
      // Extract volume as number (e.g., "1GB" -> 1)
      const volumeGb = parseInt(pkg.size.toString().replace(/[^0-9]/g, "")) || 0

      // Create order
      const order = await shopOrderService.createShopOrder({
        shop_id: shop.id,
        customer_name: orderData.customer_name,
        customer_email: orderData.customer_email,
        customer_phone: normalizedPhone,
        shop_package_id: selectedPackage.id,
        package_id: pkg.id,
        network: pkg.network,
        volume_gb: volumeGb,
        base_price: basePrice,
        profit_amount: profitAmount,
        total_price: totalPrice,
      })

      // Initialize Paystack payment
      toast.info("Redirecting to payment...")
      const { data: { session } } = await supabase.auth.getSession()
      
      const paymentResponse = await fetch("/api/payments/initialize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: totalPrice,
          email: orderData.customer_email,
          userId: session?.user?.id || null,
          shopId: shop.id,
          orderId: order.id,  // Pass order ID for shop order redirect
          shopSlug: shopSlug,  // Pass shop slug for order confirmation URL
        }),
      })

      if (!paymentResponse.ok) {
        const error = await paymentResponse.json()
        throw new Error(error.error || "Failed to initialize payment")
      }

      const paymentData = await paymentResponse.json()
      
      // Redirect to Paystack
      if (paymentData.authorizationUrl) {
        window.location.href = paymentData.authorizationUrl
        return
      }

      // Reset form
      setOrderData({ customer_name: "", customer_email: "", customer_phone: "" })
      setCheckoutOpen(false)
      setSelectedPackage(null)

      // Redirect to confirmation page
      router.push(`/shop/${shopSlug}/order-confirmation/${order.id}`)
    } catch (error) {
      console.error("Error submitting order:", error)
      toast.error("Failed to place order. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex items-center justify-center">
        <div className="text-center">
          <Store className="w-12 h-12 mx-auto text-gray-400 mb-2" />
          <p className="text-gray-600">Loading store...</p>
        </div>
      </div>
    )
  }

  if (!shop) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-4">
        <div className="max-w-2xl mx-auto pt-20">
          <Alert className="border-red-300 bg-red-50">
            <AlertCircle className="h-4 w-4 text-red-600" />
            <AlertDescription className="text-red-700">
              Store not found. Please check the URL and try again.
            </AlertDescription>
          </Alert>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      {/* Shop Header */}
      {shop.banner_url && (
        <div className="h-48 relative overflow-hidden">
          <img
            src={shop.banner_url}
            alt={shop.shop_name}
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-black/30" />
        </div>
      )}

      <div className="max-w-6xl mx-auto px-4">
        {/* Shop Info */}
        <div className="flex items-end gap-4 -mt-12 relative z-10 mb-8">
          {shop.logo_url && (
            <img
              src={shop.logo_url}
              alt={shop.shop_name}
              className="w-24 h-24 rounded-lg object-cover border-4 border-white shadow-lg"
            />
          )}
          <div className="pb-2 flex-1">
            <h1 className="text-4xl font-bold text-gray-900">{shop.shop_name}</h1>
            <p className="text-gray-600 mt-1">{shop.description || "Welcome to our store"}</p>
          </div>
        </div>

        {/* Network Selection Section */}
        <div className="py-8">
          <h2 className="text-2xl font-bold mb-6">Select a Network</h2>

          {packages.length === 0 ? (
            <Card className="bg-white border-2 border-dashed border-gray-300">
              <CardContent className="pt-12 pb-12 text-center">
                <Store className="w-12 h-12 mx-auto text-gray-400 mb-3" />
                <p className="text-gray-600">No packages available at the moment</p>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
                {Array.from(new Set(packages.map(p => p.packages.network))).map((network) => {
                  const networkPackages = packages.filter(p => p.packages.network === network)
                  const availableCount = networkPackages.filter(p => p.is_available).length

                  return (
                    <Card
                      key={network}
                      onClick={() => setSelectedNetwork(network as string)}
                      className={`cursor-pointer hover:shadow-lg transition-all duration-300 hover:-translate-y-1 overflow-hidden ${
                        selectedNetwork === network
                          ? "ring-2 ring-violet-600"
                          : "hover:shadow-lg"
                      }`}
                    >
                      <div className="flex flex-col h-full relative">
                        {/* Logo Section - Larger */}
                        <div className="h-48 w-full flex items-center justify-center bg-gray-100 relative overflow-hidden">
                          <img 
                            src={getNetworkLogo(network as string)} 
                            alt={network}
                            className="h-40 w-40 object-contain"
                          />
                        </div>
                        
                        {/* Info Section */}
                        <div className="flex-1 p-4 bg-white flex flex-col justify-between">
                          <div>
                            <h3 className="text-lg font-bold text-gray-900 uppercase">{network}</h3>
                            <p className="text-xs text-gray-600 mt-2">Choose the plan that's right for you</p>
                          </div>
                        </div>
                      </div>
                    </Card>
                  )
                })}
              </div>

              {/* Packages Section */}
              {selectedNetwork && (
                <div className="py-8 border-t border-gray-200">
                  <h2 className="text-2xl font-bold mb-6">{selectedNetwork} Packages</h2>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {packages
                      .filter(p => p.packages.network === selectedNetwork)
                      .map((shopPkg) => {
                        const pkg = shopPkg.packages
                        const totalPrice = pkg.price + shopPkg.profit_margin

                        return (
                          <Card key={shopPkg.id} className="hover:shadow-xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-violet-500 bg-gradient-to-br from-violet-50/60 to-purple-50/40 backdrop-blur-xl border border-violet-200/40">
                            <CardHeader>
                              <div className="flex items-start justify-between">
                                <div className="flex-1">
                                  <CardTitle className="text-lg">{pkg.size}GB</CardTitle>
                                  <CardDescription className="text-sm">{pkg.description}</CardDescription>
                                </div>
                                <Badge className="bg-gradient-to-r from-violet-600 to-purple-600">
                                  {shopPkg.is_available ? "Available" : "Unavailable"}
                                </Badge>
                              </div>
                            </CardHeader>
                            <CardContent className="space-y-4">
                              <div className="flex justify-between items-end pt-4 border-t border-white/20">
                                <span className="font-semibold text-gray-700">Price:</span>
                                <span className="text-2xl font-bold bg-gradient-to-r from-violet-600 to-purple-600 bg-clip-text text-transparent">
                                  GHS {totalPrice.toFixed(2)}
                                </span>
                              </div>

                              <Button
                                onClick={() => handleBuyNow(shopPkg)}
                                disabled={!shopPkg.is_available}
                                className="w-full bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 disabled:opacity-50"
                              >
                                <ShoppingCart className="w-4 h-4 mr-2" />
                                Buy Now
                              </Button>
                            </CardContent>
                          </Card>
                        )
                      })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Checkout Modal */}
      {checkoutOpen && selectedPackage && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <Card className="w-full max-w-md bg-white">
            <CardHeader className="border-b border-gray-200">
              <CardTitle>Checkout</CardTitle>
              <CardDescription>
                {selectedPackage.packages.network} - {selectedPackage.packages.size}GB
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-6 space-y-4">
              <div>
                <Label>Full Name *</Label>
                <Input
                  value={orderData.customer_name}
                  onChange={(e) => setOrderData({ ...orderData, customer_name: e.target.value })}
                  placeholder="John Doe"
                  className="mt-1"
                />
              </div>

              <div>
                <Label>Email Address *</Label>
                <Input
                  type="email"
                  value={orderData.customer_email}
                  onChange={(e) => setOrderData({ ...orderData, customer_email: e.target.value })}
                  placeholder="john@example.com"
                  className="mt-1"
                />
              </div>

              <div>
                <Label>Phone Number (MTN, Telecel, AT) *</Label>
                <Input
                  value={orderData.customer_phone}
                  onChange={(e) => setOrderData({ ...orderData, customer_phone: e.target.value })}
                  placeholder="0201234567 or 0551234567"
                  className="mt-1"
                />
                <p className="text-xs text-gray-600 mt-1">
                  Format: 10 digits starting with 02 or 05 (e.g., 0201234567)
                </p>
              </div>

              {/* Order Summary */}
              <div className="p-4 bg-gradient-to-br from-violet-50/60 to-purple-50/40 rounded-lg border border-violet-200/40">
                <div className="flex justify-between items-end mb-3">
                  <span className="font-semibold text-gray-700">Total Amount:</span>
                  <span className="text-2xl font-bold bg-gradient-to-r from-violet-600 to-purple-600 bg-clip-text text-transparent">
                    GHS {(selectedPackage.packages.price + selectedPackage.profit_margin).toFixed(2)}
                  </span>
                </div>
              </div>

              <Alert className="border-blue-300 bg-blue-50">
                <AlertCircle className="h-4 w-4 text-blue-600" />
                <AlertDescription className="text-xs text-blue-700">
                  You will be redirected to Paystack to complete your payment.
                </AlertDescription>
              </Alert>

              <div className="flex gap-2 pt-4">
                <Button
                  onClick={handleSubmitOrder}
                  disabled={submitting}
                  className="flex-1 bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700"
                >
                  {submitting ? "Processing..." : "Place Order"}
                  {!submitting && <ArrowRight className="w-4 h-4 ml-2" />}
                </Button>
                <Button
                  onClick={() => {
                    setCheckoutOpen(false)
                    setSelectedPackage(null)
                    setOrderData({ customer_name: "", customer_email: "", customer_phone: "" })
                  }}
                  variant="outline"
                  className="flex-1"
                >
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
