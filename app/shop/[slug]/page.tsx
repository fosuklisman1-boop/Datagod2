"use client"

import { useEffect, useState, useRef } from "react"
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
import { validatePhoneNumber } from "@/lib/phone-validation"
import { verifyPayment } from "@/lib/payment-service"
import { AlertCircle, Store, ShoppingCart, ArrowRight, Package, Loader2, Search, MessageCircle, MapPin, Clock, AlignJustify } from "lucide-react"
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
  const [activeTab, setActiveTab] = useState<"products" | "about" | "track-order">("products")
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [orderData, setOrderData] = useState({
    customer_name: "",
    customer_email: "",
    customer_phone: "",
  })
  const [submitting, setSubmitting] = useState(false)
  const packagesRef = useRef<HTMLDivElement>(null)

  const { settings: shopSettings } = useShopSettings(shop?.id)

  useEffect(() => {
    loadShopData()
    loadNetworkLogos()
  }, [shopSlug])

  useEffect(() => {
    // Scroll to packages when network is selected
    if (selectedNetwork && packagesRef.current) {
      setTimeout(() => {
        packagesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
      }, 100)
    }
  }, [selectedNetwork])

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

  const validatePhoneNumberField = (phone: string, network?: string): boolean => {
    const result = validatePhoneNumber(phone, network)
    return result.isValid
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

    if (!validatePhoneNumberField(orderData.customer_phone, selectedPackage.network)) {
      toast.error("Please enter a valid phone number")
      return
    }

    try {
      setSubmitting(true)

      // Normalize phone number using shared utility
      const phoneResult = validatePhoneNumber(orderData.customer_phone, selectedPackage.network)
      if (!phoneResult.isValid) {
        throw new Error(phoneResult.error || "Invalid phone number")
      }
      const normalizedPhone = phoneResult.normalized

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
      toast.info("Initializing payment...")
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
      
      // Use Paystack Inline popup instead of redirect
      // Note: NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY is intentionally public (pk_*) and safe to expose
      const paystackPublicKey = process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY
      
      if (!paystackPublicKey) {
        throw new Error("Paystack public key not configured")
      }

      if (!window.PaystackPop) {
        throw new Error("Paystack script not loaded. Please refresh the page and try again.")
      }

      // Helper to reset loading state on payment completion/failure
      const resetLoadingState = () => setSubmitting(false)

      // Open Paystack inline popup
      const handler = window.PaystackPop.setup({
        key: paystackPublicKey,
        email: orderData.customer_email,
        amount: Math.round(totalPrice * 100), // Convert to pesewas (smallest currency unit)
        ref: paymentData.reference,
        onClose: () => {
          toast.info("Payment cancelled")
          resetLoadingState()
        },
        onSuccess: async (response: { reference: string; status: string }) => {
          try {
            toast.info("Verifying payment...")
            
            // Verify the payment
            const verificationResult = await verifyPayment({ reference: response.reference })
            
            if (verificationResult.status === "success") {
              toast.success("Payment successful!")
              
              // Reset form
              setOrderData({ customer_name: "", customer_email: "", customer_phone: "" })
              setCheckoutOpen(false)
              setSelectedPackage(null)
              
              // Redirect to order confirmation page
              router.push(`/shop/${shopSlug}/order-confirmation/${order.id}`)
            } else {
              toast.error("Payment verification failed. Please contact support.")
              resetLoadingState()
            }
          } catch (verifyError) {
            console.error("Payment verification error:", verifyError)
            toast.error("Payment verification failed. Please contact support.")
            resetLoadingState()
          }
        },
      })

      handler.openIframe()
      // Note: Don't reset submitting state here; the onSuccess/onClose callbacks will handle it
    } catch (error) {
      console.error("Error submitting order:", error)
      toast.error("Failed to place order. Please try again.")
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
  const tabs: Array<{ id: "products" | "about" | "track-order", label: string, icon: React.ReactNode }> = [
    { id: "products", label: "Products", icon: <ShoppingCart className="w-4 h-4" /> },
    { id: "track-order", label: "Track Order", icon: <Package className="w-4 h-4" /> },
    { id: "about", label: "About", icon: <AlertCircle className="w-4 h-4" /> },
  ]

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      {/* Navigation Bar */}
      <nav className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3 flex-1">
            {/* 3-Line Hamburger Button */}
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-2 hover:bg-violet-50 text-gray-700 hover:text-violet-600 rounded-lg transition-all duration-200 hover:shadow-md"
              aria-label="Toggle navigation menu"
              aria-expanded={sidebarOpen}
            >
              <AlignJustify className="w-6 h-6" />
            </button>
            
            {/* Shop Info */}
            <div className="flex items-center gap-3">
              <Store className="w-6 h-6 text-violet-600 hidden sm:block" />
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900 truncate">
                {shop.shop_name || shop.name || "Store"}
              </h1>
            </div>
          </div>
          
          {/* Shop Logo */}
          {shop.logo_url && (
            <img
              src={shop.logo_url}
              alt={shop.shop_name || "Shop"}
              className="w-10 h-10 sm:w-12 sm:h-12 rounded-lg object-cover border-2 border-gray-200 flex-shrink-0"
            />
          )}
        </div>
      </nav>

      {/* Mobile Sidebar Overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-20 transition-opacity duration-200"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Collapsible Sidebar */}
      <aside
        className={`fixed left-0 top-16 h-[calc(100vh-64px)] bg-white border-r border-gray-200 w-64 transform transition-all duration-300 ease-in-out z-30 shadow-lg ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="sticky top-0 overflow-y-auto h-full">
          <Card className="border-0 shadow-none rounded-none h-full">
            <CardContent className="p-4">
              <nav className="space-y-1">
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => {
                      setActiveTab(tab.id)
                      setSidebarOpen(false)
                    }}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg font-medium transition-all duration-200 ${
                      activeTab === tab.id
                        ? "bg-violet-100 text-violet-700 border-l-4 border-l-violet-600 shadow-sm"
                        : "text-gray-700 hover:bg-gray-50 border-l-4 border-l-transparent"
                    }`}
                  >
                    {tab.icon}
                    <span>{tab.label}</span>
                  </button>
                ))}
              </nav>
            </CardContent>
          </Card>
        </div>
      </aside>
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
        {/* Shop Description Section */}
        <div className="py-8 mb-8 text-center px-2">
          <p className="text-gray-600 break-words text-sm sm:text-base md:text-lg">{shop.description || "Welcome to our store"}</p>
          <div className="flex flex-wrap gap-3 mt-4 justify-center">
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

        {/* Main Content Layout */}
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Main Content */}
          <div className="flex-1 min-w-0">
            {/* Products Tab */}
            {activeTab === "products" && (
              <div className="space-y-8">
                {/* Network Selection Section */}
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
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mb-8">
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
                                <div className="h-20 w-full flex items-center justify-center bg-gray-100 relative overflow-hidden">
                                  <img 
                                    src={getNetworkLogo(network as string)} 
                                    alt={network}
                                    className="h-16 w-16 object-contain"
                                  />
                                </div>
                                
                                <div className="flex-1 p-2 bg-white flex flex-col justify-between">
                                  <div>
                                    <h3 className="text-sm font-bold text-gray-900 uppercase">{network}</h3>
                                    <p className="text-xs text-gray-600 mt-1">{availableCount} plans</p>
                                  </div>
                                </div>
                              </div>
                            </Card>
                          )
                        })}
                      </div>

                      {selectedNetwork && (
                        <div ref={packagesRef} className="py-8 border-t border-gray-200">
                          <h2 className="text-2xl font-bold mb-6">{selectedNetwork} Packages</h2>

                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {packages
                              .filter(p => p.packages.network === selectedNetwork)
                              .sort((a, b) => {
                                // Extract volume as number from size string (e.g., "1GB" -> 1)
                                const sizeA = parseInt(a.packages.size.toString().replace(/[^0-9]/g, "")) || 0
                                const sizeB = parseInt(b.packages.size.toString().replace(/[^0-9]/g, "")) || 0
                                return sizeA - sizeB
                              })
                              .map((shopPkg) => {
                                const pkg = shopPkg.packages
                                const totalPrice = pkg.price + shopPkg.profit_margin

                                return (
                                  <Card key={shopPkg.id} className="hover:shadow-xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-violet-500 bg-gradient-to-br from-violet-50/60 to-purple-50/40 backdrop-blur-xl border border-violet-200/40">
                                    <CardHeader>
                                      <div className="flex items-start justify-between">
                                        <div className="flex-1">
                                          <CardTitle className="text-lg">{pkg.size.toString().replace(/[^0-9]/g, "")}GB</CardTitle>
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
            )}

            {/* About Tab */}
            {activeTab === "about" && (
              <div className="space-y-6">
                <Card className="border-0 shadow-md">
                  <CardHeader className="pb-3">
                    <CardTitle>Shop Information</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {shop.phone && (
                      <div className="flex items-start gap-2">
                        <MessageCircle className="w-4 h-4 text-gray-500 mt-0.5 flex-shrink-0" />
                        <div>
                          <p className="font-semibold text-gray-900">Phone</p>
                          <span className="text-gray-700">{shop.phone}</span>
                        </div>
                      </div>
                    )}
                    {shop.location && (
                      <div className="flex items-start gap-2">
                        <MapPin className="w-4 h-4 text-gray-500 mt-0.5 flex-shrink-0" />
                        <div>
                          <p className="font-semibold text-gray-900">Location</p>
                          <span className="text-gray-700">{shop.location}</span>
                        </div>
                      </div>
                    )}
                    <div className="flex items-start gap-2 pt-2 border-t">
                      <Clock className="w-4 h-4 text-gray-500 mt-0.5 flex-shrink-0" />
                      <div>
                        <p className="font-semibold text-gray-900">Support</p>
                        <p className="text-gray-700">24/7 Support Available</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            {/* Track Order Tab */}
            {activeTab === "track-order" && (
              <div className="space-y-6">
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
                  A secure Paystack payment popup will open to complete your payment.
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

      {/* Floating WhatsApp Icon */}
      {shopSettings?.whatsapp_link && (
        <a
          href={shopSettings.whatsapp_link}
          target="_blank"
          rel="noopener noreferrer"
          className="fixed bottom-6 right-6 p-4 bg-green-500 hover:bg-green-600 text-white rounded-full shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-110 z-50 flex items-center justify-center"
          title="Contact on WhatsApp"
        >
          <MessageCircle className="w-6 h-6" />
        </a>
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

    // Check for valid Ghanaian networks: 02x or 05x
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
      <Card>
        <CardContent className="pt-6">
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
        </CardContent>
      </Card>

      {/* Results */}
      {searched && (
        <>
          {orders.length === 0 ? (
            <Card>
              <CardContent className="pt-8 pb-8">
                <div className="text-center space-y-4">
                  <AlertCircle className="w-12 h-12 text-gray-400 mx-auto" />
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">No orders found</h3>
                    <p className="text-gray-600">
                      We couldn't find any orders with phone number: <span className="font-mono font-semibold">{phoneNumber}</span>
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base sm:text-lg font-bold text-gray-900">
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
