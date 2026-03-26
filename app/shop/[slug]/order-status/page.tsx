"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Search, AlertCircle, CheckCircle, Clock, XCircle, Package, Loader2, Store, CreditCard } from "lucide-react"
import { shopService } from "@/lib/shop-service"
import { toast } from "sonner"

interface ShopOrder {
  id: string
  customer_name: string
  customer_email: string
  customer_phone: string
  network: string
  volume_gb: number
  base_price: number
  profit_amount: number
  total_price: number
  order_status: string
  payment_status: string
  reference_code: string
  created_at: string
  updated_at: string
}

export default function OrderStatusPage() {
  const params = useParams()
  const shopSlug = params.slug as string

  const [shop, setShop] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [searching, setSearching] = useState(false)

  const [phoneNumber, setPhoneNumber] = useState("")
  const [orders, setOrders] = useState<ShopOrder[]>([])
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [referenceInputs, setReferenceInputs] = useState<Record<string, string>>({})
  const [verifyingOrder, setVerifyingOrder] = useState<string | null>(null)

  useEffect(() => {
    loadShopData()
  }, [shopSlug])

  const loadShopData = async () => {
    try {
      setLoading(true)
      const shopData = await shopService.getShopBySlug(shopSlug)

      if (!shopData) {
        toast.error("Shop not found")
        setError("Shop not found")
        return
      }

      setShop(shopData)
    } catch (err) {
      console.error("Error loading shop:", err)
      const errorMessage = err instanceof Error ? err.message : "Failed to load shop"
      toast.error(errorMessage)
      setError("Failed to load shop information")
    } finally {
      setLoading(false)
    }
  }

  const validatePhoneNumber = (phone: string): boolean => {
    const cleaned = phone.replace(/\D/g, "")
    let normalized = cleaned

    if (cleaned.length === 9) {
      normalized = "0" + cleaned
    }

    if (normalized.length !== 10 || !normalized.startsWith("0")) {
      return false
    }

    const thirdDigit = normalized[2]
    return ["2", "5"].includes(thirdDigit)
  }

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!phoneNumber.trim()) {
      toast.error("Please enter a phone number")
      return
    }

    if (!validatePhoneNumber(phoneNumber)) {
      toast.error("Please enter a valid phone number (starting with 02 or 05)")
      return
    }

    try {
      setSearching(true)
      setError(null)
      setOrders([])

      // Normalize phone number
      const cleaned = phoneNumber.replace(/\D/g, "")
      const normalizedPhone = cleaned.length === 9 ? "0" + cleaned : cleaned

      const response = await fetch("/api/shop/orders/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: normalizedPhone,
          shopId: shop.id
        })
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || "Failed to search orders")
      }

      const data = await response.json()
      // Sort by newest first (in case API doesn't return sorted)
      const sortedOrders = (data.orders || []).sort((a: ShopOrder, b: ShopOrder) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )
      setOrders(sortedOrders)
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

  const getStatusIcon = (status: string) => {
    switch (status?.toLowerCase()) {
      case "completed":
        return <CheckCircle className="w-4 h-4" />
      case "processing":
        return <Loader2 className="w-4 h-4 animate-spin" />
      case "pending":
        return <Clock className="w-4 h-4" />
      case "failed":
      case "cancelled":
        return <XCircle className="w-4 h-4" />
      default:
        return <AlertCircle className="w-4 h-4" />
    }
  }

  const getPaymentStatusColor = (status: string) => {
    switch (status?.toLowerCase()) {
      case "completed":
        return "bg-green-50 border-green-200"
      case "pending":
        return "bg-yellow-50 border-yellow-200"
      case "failed":
        return "bg-red-50 border-red-200"
      default:
        return "bg-gray-50 border-gray-200"
    }
  }

  const verifyPaymentReference = async (order: ShopOrder) => {
    const ref = referenceInputs[order.id]?.trim()
    if (!ref) {
      toast.error("Please enter the payment reference from your Paystack email")
      return
    }

    setVerifyingOrder(order.id)
    try {
      const response = await fetch("/api/payments/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference: ref }),
      })
      const result = await response.json()

      if (!response.ok) {
        throw new Error(result.error || "Verification failed")
      }

      if (result.status === "success" || result.status === "completed") {
        toast.success("Payment verified! Your order is being processed.")
        // Update order in place
        setOrders(prev => prev.map(o =>
          o.id === order.id
            ? { ...o, payment_status: "completed", order_status: o.order_status === "pending" ? "processing" : o.order_status }
            : o
        ))
        // Clear the reference input
        setReferenceInputs(prev => {
          const copy = { ...prev }
          delete copy[order.id]
          return copy
        })
      } else if (result.status === "failed" || result.status === "abandoned") {
        toast.error(`Payment ${result.status}. This reference was not paid on Paystack.`)
      } else {
        toast.info("Payment is still processing. Please try again in a few minutes.")
      }
    } catch (err) {
      console.error("Error verifying payment:", err)
      toast.error(err instanceof Error ? err.message : "Verification failed")
    } finally {
      setVerifyingOrder(null)
    }
  }


  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 flex flex-col items-center gap-4">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
            <p className="text-gray-600">Loading shop...</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (error && !shop) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 flex items-center justify-center">
        <Card className="w-full max-w-md border-red-200">
          <CardContent className="pt-6">
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Store className="w-6 h-6 text-blue-600" />
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{shop?.shop_name}</h1>
              <p className="text-sm text-gray-600">Check your order status</p>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Search Card */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Search className="w-5 h-5" />
              Search Your Orders
            </CardTitle>
            <CardDescription>
              Enter your phone number to view all your orders from this store
            </CardDescription>
          </CardHeader>
          <CardContent>
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

        {/* Results Section */}
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
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-bold text-gray-900">
                    Found {orders.length} Order{orders.length !== 1 ? "s" : ""}
                  </h2>
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
                        <div className="text-right space-y-1">
                          <div className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-semibold border ${getStatusColor(order.order_status)}`}>
                            {getStatusIcon(order.order_status)}
                            {order.order_status?.charAt(0).toUpperCase() + order.order_status?.slice(1)}
                          </div>
                          {order.payment_status && (
                            <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold border ml-2 ${getPaymentStatusColor(order.payment_status)}`}>
                              Payment: {order.payment_status?.charAt(0).toUpperCase() + order.payment_status?.slice(1)}
                            </div>
                          )}
                        </div>
                      </div>
                    </CardHeader>

                    <CardContent className="space-y-3">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div className="space-y-1">
                          <p className="text-xs text-gray-600">Price</p>
                          <p className="font-semibold text-gray-900">₵ {(order.base_price || 0).toFixed(2)}</p>
                        </div>
                        <div className="space-y-1">
                          <p className="text-xs text-gray-600">Total</p>
                          <p className="font-semibold text-gray-900">₵ {(order.total_price || 0).toFixed(2)}</p>
                        </div>
                        <div className="space-y-1">
                          <p className="text-xs text-gray-600">Customer Name</p>
                          <p className="font-semibold text-gray-900">{order.customer_name || 'N/A'}</p>
                        </div>
                        <div className="space-y-1">
                          <p className="text-xs text-gray-600">Phone</p>
                          <p className="font-mono text-sm font-semibold text-gray-900">{order.customer_phone}</p>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 pt-2 border-t">
                        <div className="space-y-1">
                          <p className="text-xs text-gray-600">Email</p>
                          <p className="text-sm text-gray-900 break-all">{order.customer_email || 'N/A'}</p>
                        </div>
                        <div className="space-y-1">
                          <p className="text-xs text-gray-600">Ordered</p>
                          <p className="text-sm text-gray-900">{new Date(order.created_at).toLocaleString()}</p>
                        </div>
                        <div className="space-y-1">
                          <p className="text-xs text-gray-600">Last Updated</p>
                          <p className="text-sm text-gray-900">{new Date(order.updated_at).toLocaleString()}</p>
                        </div>
                      </div>

                      {/* Payment Verification for pending orders */}
                      {(order.payment_status === "pending" || order.payment_status === "abandoned") && (
                        <div className="pt-3 border-t bg-yellow-50 -mx-6 px-6 pb-1 rounded-b-lg">
                          <div className="flex items-center gap-2 mb-2">
                            <CreditCard className="w-4 h-4 text-yellow-600" />
                            <p className="text-sm font-semibold text-yellow-800">Payment not confirmed?</p>
                          </div>
                          <p className="text-xs text-yellow-700 mb-3">
                            If you completed payment but it&apos;s still showing as pending, enter the payment reference from your Paystack email below.
                          </p>
                          <div className="flex gap-2">
                            <Input
                              placeholder="Paystack reference (e.g. t6j8k2m9n4)"
                              value={referenceInputs[order.id] || ""}
                              onChange={(e) => setReferenceInputs(prev => ({ ...prev, [order.id]: e.target.value }))}
                              disabled={verifyingOrder === order.id}
                              className="flex-1 bg-white text-sm"
                              onKeyDown={(e) => { if (e.key === "Enter") verifyPaymentReference(order) }}
                            />
                            <Button
                              size="sm"
                              onClick={() => verifyPaymentReference(order)}
                              disabled={verifyingOrder === order.id || !referenceInputs[order.id]?.trim()}
                              className="bg-yellow-600 hover:bg-yellow-700 text-white whitespace-nowrap"
                            >
                              {verifyingOrder === order.id ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                "Verify Payment"
                              )}
                            </Button>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}

        {/* Empty State */}
        {!searched && (
          <Card>
            <CardContent className="pt-16 pb-16">
              <div className="text-center space-y-4">
                <Package className="w-16 h-16 text-gray-400 mx-auto" />
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">Track Your Orders</h3>
                  <p className="text-gray-600">Enter your phone number above to search for your orders</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
