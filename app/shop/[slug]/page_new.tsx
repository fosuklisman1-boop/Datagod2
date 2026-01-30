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
import { useShopSettings } from "@/hooks/use-shop-settings"
import { AlertCircle, Store, ShoppingCart, ArrowRight, Zap, Package, Loader2, Search, MessageCircle, MapPin, Clock, Home, Info, Phone } from "lucide-react"
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
  const [activeTab, setActiveTab] = useState<"products" | "about" | "contact">("products")
  const [orderData, setOrderData] = useState({
    customer_name: "",
    customer_email: "",
    customer_phone: "",
  })
  const [submitting, setSubmitting] = useState(false)
  const [globalOrderingEnabled, setGlobalOrderingEnabled] = useState(true)

  const { settings: shopSettings } = useShopSettings(shop?.id)

  useEffect(() => {
    loadShopData()
    loadNetworkLogos()
    loadGlobalSettings()
  }, [shopSlug])

  const loadGlobalSettings = async () => {
    try {
      const response = await fetch("/api/shop/public-packages?slug=" + shopSlug, { cache: "no-store" })
      const data = await response.json()
      if (data.ordering_enabled !== undefined) {
        setGlobalOrderingEnabled(data.ordering_enabled)
      }
    } catch (error) {
      console.error("Error loading global settings:", error)
    }
  }

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
    }
  }

  const handleBuyNow = (pkg: any) => {
    setSelectedPackage(pkg)
    setCheckoutOpen(true)
  }

  const getNetworkLogo = (network: string): string => {
    if (networkLogos[network]) {
      return networkLogos[network]
    }

    const normalized = network.charAt(0).toUpperCase() + network.slice(1).toLowerCase()
    if (networkLogos[normalized]) {
      return networkLogos[normalized]
    }

    return ""
  }

  const validatePhoneNumber = (phone: string): boolean => {
    const cleaned = phone.replace(/\D/g, "")

    let normalized = cleaned
    if (cleaned.length === 9) {
      normalized = "0" + cleaned
    }

    return normalized.length === 10
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
      toast.error("Please enter a valid 10-digit phone number")
      return
    }

    try {
      setSubmitting(true)

      const cleaned = orderData.customer_phone.replace(/\D/g, "")
      const normalizedPhone = cleaned.length === 9 ? "0" + cleaned : cleaned

      const pkg = selectedPackage.packages
      const basePrice = pkg.price
      const profitAmount = selectedPackage.profit_margin
      const totalPrice = basePrice + profitAmount

      const volumeGb = parseInt(pkg.size.toString().replace(/[^0-9]/g, "")) || 0

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
          orderId: order.id,
          shopSlug: shopSlug,
        }),
      })

      if (!paymentResponse.ok) {
        const error = await paymentResponse.json()
        throw new Error(error.error || "Failed to initialize payment")
      }

      const paymentData = await paymentResponse.json()

      if (paymentData.authorizationUrl) {
        sessionStorage.setItem('lastPaymentReference', paymentData.reference || "")
        window.location.href = paymentData.authorizationUrl
        return
      }

      setOrderData({ customer_name: "", customer_email: "", customer_phone: "" })
      setCheckoutOpen(false)
      setSelectedPackage(null)

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

  // Tab navigation items
  const tabs: Array<{ id: "products" | "about" | "contact", label: string, icon: React.ReactNode }> = [
    { id: "products", label: "Products", icon: <ShoppingCart className="w-4 h-4" /> },
    { id: "about", label: "About", icon: <Info className="w-4 h-4" /> },
    { id: "contact", label: "Contact", icon: <Phone className="w-4 h-4" /> },
  ]

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      {!globalOrderingEnabled && (
        <div className="max-w-7xl mx-auto px-4 pt-4">
          <Alert className="border-red-500 bg-red-50 shadow-md">
            <AlertDescription className="text-red-800 font-bold text-center">
              Global ordering is currently disabled for maintenance. You cannot place orders at this time.
            </AlertDescription>
          </Alert>
        </div>
      )}
      {/* Banner */}
      {shop.banner_url && (
        <div className="h-40 relative overflow-hidden">
          <img
            src={shop.banner_url}
            alt={shop.shop_name}
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-black/30" />
        </div>
      )}

      <div className="max-w-7xl mx-auto px-4">
        {/* Shop Header */}
        <div className="flex flex-col md:flex-row items-start gap-6 -mt-16 md:-mt-20 relative z-10 mb-8">
          {shop.logo_url && (
            <img
              src={shop.logo_url}
              alt={shop.shop_name || "Shop"}
              className="w-24 h-24 rounded-lg object-cover border-4 border-white shadow-lg"
            />
          )}
          <div className="flex-1 pt-2">
            <h1 className="text-3xl md:text-4xl font-bold text-gray-900 break-words">{shop.shop_name || shop.name || "Store"}</h1>
            <p className="text-gray-600 mt-2 break-words">{shop.description || "Welcome to our store"}</p>
            <div className="flex flex-wrap gap-3 mt-4">
              {shopSettings?.whatsapp_link && (
                <a
                  href={shopSettings.whatsapp_link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-semibold transition-colors"
                >
                  <MessageCircle className="w-4 h-4" />
                  Contact on WhatsApp
                </a>
              )}
            </div>
          </div>
        </div>

        {/* Main Content Layout: Sidebar + Content */}
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Sidebar Navigation */}
          <div className="lg:w-48 flex-shrink-0">
            <div className="sticky top-4">
              <Card className="border-0 shadow-md">
                <CardContent className="p-4">
                  <nav className="space-y-2">
                    {tabs.map((tab) => (
                      <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg font-medium transition-all ${activeTab === tab.id
                            ? "bg-violet-100 text-violet-700 border-l-4 border-l-violet-600"
                            : "text-gray-700 hover:bg-gray-100"
                          }`}
                      >
                        {tab.icon}
                        {tab.label}
                      </button>
                    ))}
                  </nav>
                </CardContent>
              </Card>

              {/* Shop Info Card */}
              <Card className="mt-4 border-0 shadow-md">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">Shop Information</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {shop.phone && (
                    <div className="flex items-start gap-2">
                      <Phone className="w-4 h-4 text-gray-500 mt-0.5 flex-shrink-0" />
                      <span className="text-gray-700">{shop.phone}</span>
                    </div>
                  )}
                  {shop.location && (
                    <div className="flex items-start gap-2">
                      <MapPin className="w-4 h-4 text-gray-500 mt-0.5 flex-shrink-0" />
                      <span className="text-gray-700">{shop.location}</span>
                    </div>
                  )}
                  <div className="flex items-start gap-2 pt-2 border-t">
                    <Clock className="w-4 h-4 text-gray-500 mt-0.5 flex-shrink-0" />
                    <div className="text-gray-700">
                      <p>24/7 Support</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Main Content */}
          <div className="flex-1 min-w-0">
            {/* Products Tab */}
            {activeTab === "products" && (
              <div className="space-y-8">
                {/* Network Selection */}
                <div>
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
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                        {Array.from(new Set(packages.map(p => p.packages.network))).map((network) => {
                          const networkPackages = packages.filter(p => p.packages.network === network)
                          const availableCount = networkPackages.filter(p => p.is_available).length

                          return (
                            <Card
                              key={network}
                              onClick={() => setSelectedNetwork(network as string)}
                              className={`cursor-pointer hover:shadow-lg transition-all duration-300 hover:-translate-y-1 overflow-hidden ${selectedNetwork === network
                                  ? "ring-2 ring-violet-600"
                                  : "hover:shadow-lg"
                                }`}
                            >
                              <div className="flex flex-col h-full relative">
                                <div className="h-40 w-full flex items-center justify-center bg-gray-100 relative overflow-hidden">
                                  <img
                                    src={getNetworkLogo(network as string)}
                                    alt={network}
                                    className="h-32 w-32 object-contain"
                                  />
                                </div>

                                <div className="flex-1 p-4 bg-white flex flex-col justify-between">
                                  <div>
                                    <h3 className="text-lg font-bold text-gray-900 uppercase">{network}</h3>
                                    <p className="text-xs text-gray-600 mt-2">{availableCount} plans available</p>
                                  </div>
                                </div>
                              </div>
                            </Card>
                          )
                        })}
                      </div>

                      {/* Packages Grid */}
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
                                        disabled={!shopPkg.is_available || !globalOrderingEnabled}
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
            )}

            {/* About Tab */}
            {activeTab === "about" && (
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle>About This Store</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <h3 className="font-semibold text-gray-900 mb-2">Store Name</h3>
                      <p className="text-gray-700">{shop.shop_name || shop.name}</p>
                    </div>

                    <div>
                      <h3 className="font-semibold text-gray-900 mb-2">Description</h3>
                      <p className="text-gray-700 whitespace-pre-wrap">{shop.description || "No description available"}</p>
                    </div>

                    {shop.location && (
                      <div>
                        <h3 className="font-semibold text-gray-900 mb-2 flex items-center gap-2">
                          <MapPin className="w-4 h-4" />
                          Location
                        </h3>
                        <p className="text-gray-700">{shop.location}</p>
                      </div>
                    )}

                    {shop.phone && (
                      <div>
                        <h3 className="font-semibold text-gray-900 mb-2 flex items-center gap-2">
                          <Phone className="w-4 h-4" />
                          Phone
                        </h3>
                        <p className="text-gray-700">{shop.phone}</p>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}

            {/* Contact Tab */}
            {activeTab === "contact" && (
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle>Get in Touch</CardTitle>
                    <CardDescription>Contact this store for more information</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <div className="space-y-4">
                      {shopSettings?.whatsapp_link && (
                        <a
                          href={shopSettings.whatsapp_link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="w-full flex items-center gap-3 p-4 bg-green-50 border border-green-200 rounded-lg hover:bg-green-100 transition-colors"
                        >
                          <MessageCircle className="w-6 h-6 text-green-600 flex-shrink-0" />
                          <div className="flex-1 text-left">
                            <p className="font-semibold text-green-900">WhatsApp</p>
                            <p className="text-sm text-green-700">Send us a message on WhatsApp</p>
                          </div>
                          <ArrowRight className="w-4 h-4 text-green-600" />
                        </a>
                      )}

                      {shop.phone && (
                        <a
                          href={`tel:${shop.phone}`}
                          className="w-full flex items-center gap-3 p-4 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors"
                        >
                          <Phone className="w-6 h-6 text-blue-600 flex-shrink-0" />
                          <div className="flex-1 text-left">
                            <p className="font-semibold text-blue-900">Phone</p>
                            <p className="text-sm text-blue-700">{shop.phone}</p>
                          </div>
                          <ArrowRight className="w-4 h-4 text-blue-600" />
                        </a>
                      )}

                      {shop.location && (
                        <div className="w-full flex items-center gap-3 p-4 bg-purple-50 border border-purple-200 rounded-lg">
                          <MapPin className="w-6 h-6 text-purple-600 flex-shrink-0" />
                          <div className="flex-1 text-left">
                            <p className="font-semibold text-purple-900">Location</p>
                            <p className="text-sm text-purple-700">{shop.location}</p>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
                      <p className="text-sm text-gray-700">
                        <span className="font-semibold">Response Time:</span> We typically respond within 24 hours
                      </p>
                    </div>
                  </CardContent>
                </Card>

                {/* Order Tracking */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Package className="w-5 h-5" />
                      Track Your Order
                    </CardTitle>
                    <CardDescription>Enter your phone number to check order status</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <OrderStatusSearch shopId={shop?.id} shopName={shop?.shop_name} />
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
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

function OrderStatusSearch({ shopId, shopName }: { shopId: string; shopName: string }) {
  const [phoneNumber, setPhoneNumber] = useState("")
  const [orders, setOrders] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const validatePhoneNumber = (phone: string): boolean => {
    const cleaned = phone.replace(/\D/g, "")
    let normalized = cleaned

    if (cleaned.length === 9) {
      normalized = "0" + cleaned
    }

    if (normalized.length !== 10 || !normalized.startsWith("0")) {
      return false
    }

    const secondDigit = normalized[1]
    return ["2", "5"].includes(secondDigit)
  }

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!phoneNumber.trim()) {
      toast.error("Please enter a phone number")
      return
    }

    if (!validatePhoneNumber(phoneNumber)) {
      toast.error("Please enter a valid phone number (02x or 05x for MTN, AT, Telecel)")
      return
    }

    try {
      setSearching(true)
      setError(null)
      setOrders([])

      const cleaned = phoneNumber.replace(/\D/g, "")
      const normalizedPhone = cleaned.length === 9 ? "0" + cleaned : cleaned

      const response = await fetch("/api/shop/orders/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: normalizedPhone,
          shopId: shopId
        })
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || "Failed to search orders")
      }

      const data = await response.json()
      setOrders(data.orders || [])
      setSearched(true)

      if (data.count === 0) {
        toast.info("No orders found for this phone number")
      } else {
        toast.success(`Found ${data.count} order(s)`)
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to search orders"
      setError(errorMessage)
      toast.error(errorMessage)
      console.error("Error searching orders:", err)
    } finally {
      setSearching(false)
    }
  }

  const getStatusColor = (status: string) => {
    switch (status?.toLowerCase()) {
      case "completed":
        return "bg-green-100 text-green-800 border-green-200"
      case "processing":
        return "bg-blue-100 text-blue-800 border-blue-200"
      case "pending":
        return "bg-yellow-100 text-yellow-800 border-yellow-200"
      case "failed":
      case "cancelled":
        return "bg-red-100 text-red-800 border-red-200"
      default:
        return "bg-gray-100 text-gray-800 border-gray-200"
    }
  }

  return (
    <div className="space-y-6">
      {/* Search Form */}
      <form onSubmit={handleSearch} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="phone">Phone Number</Label>
          <div className="flex gap-2">
            <Input
              id="phone"
              placeholder="Enter phone number (e.g., 0201234567)"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              disabled={searching}
              className="flex-1"
            />
            <Button
              type="submit"
              disabled={searching}
              className="gap-2"
            >
              {searching ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Searching...
                </>
              ) : (
                <>
                  <Search className="w-4 h-4" />
                  Search
                </>
              )}
            </Button>
          </div>
        </div>
      </form>

      {/* Results */}
      {searched && (
        <>
          {orders.length === 0 ? (
            <div className="text-center space-y-4 p-8 bg-gray-50 rounded-lg">
              <AlertCircle className="w-12 h-12 text-gray-400 mx-auto" />
              <div>
                <h3 className="text-lg font-semibold text-gray-900">No orders found</h3>
                <p className="text-gray-600 text-sm">
                  We couldn't find any orders with phone number: <span className="font-mono font-semibold">{phoneNumber}</span>
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold text-gray-900">
                  Found {orders.length} Order{orders.length !== 1 ? "s" : ""}
                </h3>
                <Badge variant="outline">{orders.length}</Badge>
              </div>

              {orders.map((order) => (
                <Card key={order.id} className="overflow-hidden hover:shadow-lg transition-shadow">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div className="space-y-1 flex-1">
                        <div className="flex items-center gap-2">
                          <Package className="w-4 h-4 text-blue-600" />
                          <CardTitle className="text-base">{order.network}</CardTitle>
                          <Badge className="text-xs" variant="outline">{order.volume_gb}GB</Badge>
                        </div>
                        <CardDescription className="text-xs">
                          Order ID: <span className="font-mono">{order.reference_code}</span>
                        </CardDescription>
                      </div>
                      <div className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-semibold border ${getStatusColor(order.order_status)}`}>
                        {order.order_status?.charAt(0).toUpperCase() + order.order_status?.slice(1)}
                      </div>
                    </div>
                  </CardHeader>

                  <CardContent className="space-y-3">
                    <div className="grid grid-cols-4 gap-4">
                      <div className="space-y-1">
                        <p className="text-xs text-gray-600">Total</p>
                        <p className="font-semibold text-gray-900">₵ {order.total_price.toFixed(2)}</p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-gray-600">Customer</p>
                        <p className="font-semibold text-gray-900">{order.customer_name}</p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-gray-600">Date</p>
                        <p className="text-sm text-gray-900">{new Date(order.created_at).toLocaleDateString()}</p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-gray-600">Time</p>
                        <p className="text-sm text-gray-900">{new Date(order.created_at).toLocaleTimeString()}</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4 pt-2 border-t">
                      <div className="space-y-1">
                        <p className="text-xs text-gray-600">Order Status</p>
                        <Badge className={`text-xs border ${getStatusColor(order.order_status)}`}>
                          {order.order_status?.charAt(0).toUpperCase() + order.order_status?.slice(1)}
                        </Badge>
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-gray-600">Payment Status</p>
                        <Badge className={`text-xs border ${getStatusColor(order.payment_status)}`}>
                          {order.payment_status?.charAt(0).toUpperCase() + order.payment_status?.slice(1)}
                        </Badge>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
