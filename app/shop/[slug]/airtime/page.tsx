"use client"

import { useState, useEffect } from "react"
import { useParams, useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Store, Phone, CreditCard, ChevronLeft, Loader2, AlertCircle } from "lucide-react"
import { shopService } from "@/lib/shop-service"
import { toast } from "sonner"

export default function ShopAirtimePage() {
  const params = useParams()
  const router = useRouter()
  const shopSlug = params.slug as string

  const [shop, setShop] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [formData, setFormData] = useState({
    customerName: "",
    customerEmail: "",
    beneficiaryPhone: "",
    amount: "10",
  })

  useEffect(() => {
    loadShop()
  }, [shopSlug])

  const loadShop = async () => {
    try {
      setLoading(true)
      const data = await shopService.getShopBySlug(shopSlug)
      if (!data) {
        toast.error("Shop not found")
        return
      }
      setShop(data)
    } catch (error) {
      toast.error("Failed to load shop details")
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!formData.customerEmail || !formData.beneficiaryPhone || !formData.amount) {
      toast.error("Please fill in all required fields")
      return
    }

    try {
      setSubmitting(true)
      const res = await fetch("/api/shop/airtime/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopId: shop.id,
          ...formData
        })
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to initialize order")

      // Initialize Paystack payment
      const paymentRes = await fetch("/api/payments/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: data.totalPrice,
          email: formData.customerEmail,
          shopId: shop.id,
          orderId: data.orderId,
          orderType: "airtime", // Tell payment API this is airtime
          shopSlug
        })
      })

      const paymentData = await paymentRes.json()
      if (!paymentRes.ok) throw new Error(paymentData.error || "Payment initialization failed")

      if (paymentData.authorizationUrl) {
        window.location.href = paymentData.authorizationUrl
      } else {
        throw new Error("No payment URL received")
      }

    } catch (error: any) {
      toast.error(error.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-8 h-8 animate-spin text-violet-600" />
      </div>
    )
  }

  if (!shop) {
    return (
      <div className="min-h-screen p-4 bg-gray-50 flex items-center justify-center">
        <Alert className="max-w-md border-red-200 bg-red-50">
          <AlertCircle className="w-4 h-4 text-red-600" />
          <AlertDescription>Shop not found or inactive.</AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-20">
      {/* Header */}
      <nav className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <button onClick={() => router.back()} className="p-2 hover:bg-gray-100 rounded-full">
            <ChevronLeft className="w-6 h-6" />
          </button>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold truncate max-w-[200px]">{shop.shop_name}</h1>
          </div>
          {shop.logo_url ? (
            <img src={shop.logo_url} className="w-10 h-10 rounded-lg object-cover" alt="Logo" />
          ) : (
            <Store className="w-10 h-10 text-violet-600" />
          )}
        </div>
      </nav>

      <main className="max-w-md mx-auto px-4 pt-8">
        <Card className="border-0 shadow-lg">
          <CardHeader className="bg-gradient-to-br from-violet-600 to-indigo-700 text-white rounded-t-xl">
            <div className="flex items-center gap-3 mb-2">
              <Phone className="w-6 h-6" />
              <CardTitle>Buy Airtime</CardTitle>
            </div>
            <CardDescription className="text-violet-100">
              Top up any network instantly through {shop.shop_name}
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="customerName">Your Name (Optional)</Label>
                  <Input 
                    id="customerName"
                    placeholder="E.g John Doe"
                    value={formData.customerName}
                    onChange={e => setFormData({...formData, customerName: e.target.value})}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="customerEmail">Email Address *</Label>
                  <Input 
                    id="customerEmail"
                    type="email"
                    required
                    placeholder="your@email.com"
                    value={formData.customerEmail}
                    onChange={e => setFormData({...formData, customerEmail: e.target.value})}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">Recipient Phone Number (Ghana) *</Label>
                  <Input 
                    id="phone"
                    type="tel"
                    required
                    placeholder="0241234567"
                    value={formData.beneficiaryPhone}
                    onChange={e => setFormData({...formData, beneficiaryPhone: e.target.value})}
                  />
                  <p className="text-[10px] text-gray-500">Supports MTN, Telecel, and AT networks.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="amount">Amount (GHS) *</Label>
                  <Input 
                    id="amount"
                    type="number"
                    min="1"
                    required
                    placeholder="10.00"
                    value={formData.amount}
                    onChange={e => setFormData({...formData, amount: e.target.value})}
                    className="text-lg font-bold"
                  />
                </div>
              </div>

              <div className="p-4 bg-violet-50 rounded-lg border border-violet-100 mt-6">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-violet-700 font-medium font-semibold underline decoration-violet-300">Total to Pay:</span>
                  <span className="text-xl font-bold text-violet-900">
                    GHS {(parseFloat(formData.amount || "0") * 1.05).toFixed(2)} *
                  </span>
                </div>
                <p className="text-[10px] text-violet-600 mt-2 italic">
                  * Final price includes a small service fee. Actual total will be shown on payment page.
                </p>
              </div>

              <Button 
                type="submit" 
                disabled={submitting}
                className="w-full h-12 bg-gradient-to-r from-violet-600 to-indigo-700 hover:from-violet-700 hover:to-indigo-800 text-lg font-bold mt-4"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    Initializing...
                  </>
                ) : (
                  <>
                    <CreditCard className="w-5 h-5 mr-2" />
                    Pay with MoMo
                  </>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Support Section */}
        <div className="mt-8 text-center space-y-4">
          <p className="text-sm text-gray-500">Secure payment powered by Paystack</p>
        </div>
      </main>
    </div>
  )
}
