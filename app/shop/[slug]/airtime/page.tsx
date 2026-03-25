"use client"

import { useState, useEffect } from "react"
import { useParams, useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Store, Phone, CreditCard, ChevronLeft, Loader2, AlertCircle, Zap, ShieldCheck, CheckCircle2 } from "lucide-react"
import { shopService, networkLogoService } from "@/lib/shop-service"
import { validatePhoneNumber } from "@/lib/phone-validation"
import { toast } from "sonner"

export default function ShopAirtimePage() {
  const params = useParams()
  const router = useRouter()
  const shopSlug = params.slug as string

  const [shop, setShop] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [selectedNetwork, setSelectedNetwork] = useState<string | null>(null)
  const [networkLogos, setNetworkLogos] = useState<Record<string, string>>({})
  const [constraints, setConstraints] = useState<any>(null)
  
  const [formData, setFormData] = useState({
    customerName: "",
    customerEmail: "",
    beneficiaryPhone: "",
    amount: "10",
  })

  useEffect(() => {
    loadShop()
    loadNetworkLogos()
  }, [shopSlug])

  useEffect(() => {
    if (shop?.id && selectedNetwork) {
      loadConstraints()
    }
  }, [shop, selectedNetwork])

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

  const loadNetworkLogos = async () => {
    try {
      const logos = await networkLogoService.getLogosAsObject()
      setNetworkLogos(logos)
    } catch (error) {
      console.error("Error loading network logos:", error)
    }
  }

  const loadConstraints = async () => {
    try {
      const res = await fetch(`/api/shop/airtime/constraints?shopId=${shop.id}&network=${selectedNetwork}`)
      const data = await res.json()
      if (res.ok) {
        setConstraints(data)
      }
    } catch (error) {
      console.error("Error loading constraints:", error)
    }
  }

  const calculateTotal = () => {
    const amount = parseFloat(formData.amount || "0")
    if (isNaN(amount) || !constraints) return amount

    const baseFeePercent = constraints.baseFeePercent || 0
    const markupPercent = constraints.markupPercent || 0
    const totalFeePercent = baseFeePercent + markupPercent

    return amount + (amount * (totalFeePercent / 100))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!selectedNetwork) {
      toast.error("Please select a network")
      return
    }

    if (!formData.customerEmail || !formData.beneficiaryPhone || !formData.amount) {
      toast.error("Please fill in all required fields")
      return
    }

    // Validate phone number
    const phoneVal = validatePhoneNumber(formData.beneficiaryPhone, selectedNetwork)
    if (!phoneVal.isValid) {
      toast.error(phoneVal.error || "Invalid phone number")
      return
    }

    try {
      setSubmitting(true)
      
      const totalPrice = calculateTotal()

      const res = await fetch("/api/shop/airtime/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopId: shop.id,
          customerName: formData.customerName,
          customerEmail: formData.customerEmail,
          beneficiaryPhone: phoneVal.normalized,
          network: selectedNetwork,
          amount: formData.amount,
          totalPrice: totalPrice,
          shopSlug: shopSlug
        })
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to initialize order")

      // Initialize Paystack payment
      const paymentRes = await fetch("/api/payments/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: totalPrice,
          email: formData.customerEmail,
          shopId: shop.id,
          orderId: data.orderId,
          orderType: "airtime",
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

  const networks = [
    { id: "MTN", name: "MTN" },
    { id: "Telecel", name: "Telecel" },
    { id: "AT", name: "AT" }
  ]

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-10 h-10 animate-spin text-violet-600" />
      </div>
    )
  }

  if (!shop) {
    return (
      <div className="min-h-screen p-4 bg-slate-50 flex items-center justify-center">
        <Alert className="max-w-md border-red-200 bg-red-50 shadow-lg">
          <AlertCircle className="w-4 h-4 text-red-600" />
          <AlertDescription className="text-red-700 font-medium">Shop not found or inactive.</AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 pb-20">
      {/* Header */}
      <nav className="bg-white/80 backdrop-blur-md border-b border-gray-200 shadow-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <button 
            onClick={() => router.push(`/shop/${shopSlug}`)} 
            className="p-2 hover:bg-violet-50 text-gray-700 hover:text-violet-600 rounded-xl transition-all"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
          <div className="flex items-center gap-3">
            <Store className="w-5 h-5 text-violet-600" />
            <h1 className="text-xl font-bold text-gray-900 truncate max-w-[180px] sm:max-w-none">
              {shop.shop_name}
            </h1>
          </div>
          {shop.logo_url ? (
            <img src={shop.logo_url} className="w-10 h-10 rounded-xl object-cover border border-gray-100 shadow-sm" alt="Logo" />
          ) : (
            <div className="w-10 h-10 bg-violet-100 rounded-xl flex items-center justify-center">
              <Zap className="w-5 h-5 text-violet-600" />
            </div>
          )}
        </div>
      </nav>

      <main className="max-w-xl mx-auto px-4 pt-8">
        <Card className="border-0 shadow-2xl overflow-hidden rounded-2xl">
          <div className="h-2 bg-gradient-to-r from-violet-600 via-indigo-600 to-purple-600" />
          <CardHeader className="bg-white border-b border-slate-50">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-2xl font-black text-slate-900 flex items-center gap-2">
                  <Zap className="w-6 h-6 text-violet-600 fill-violet-600" />
                  Buy Airtime
                </CardTitle>
                <CardDescription className="text-slate-500 font-medium mt-1">
                  Secure instant top-up for any network
                </CardDescription>
              </div>
              <Badge className="bg-green-100 text-green-700 border-green-200">
                <ShieldCheck className="w-3 h-3 mr-1" />
                Verified
              </Badge>
            </div>
          </CardHeader>

          <CardContent className="pt-8 bg-white">
            <form onSubmit={handleSubmit} className="space-y-8">
              {/* Network Selection */}
              <div className="space-y-4">
                <Label className="text-slate-900 font-bold flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-violet-600" />
                  1. Select Network
                </Label>
                <div className="grid grid-cols-3 gap-3">
                  {networks.map((net) => (
                    <button
                      key={net.id}
                      type="button"
                      onClick={() => setSelectedNetwork(net.id)}
                      className={`relative flex flex-col items-center justify-center p-4 rounded-xl border-2 transition-all duration-300 ${
                        selectedNetwork === net.id
                          ? "border-violet-600 bg-violet-50 ring-4 ring-violet-100"
                          : "border-slate-100 bg-slate-50 hover:border-violet-200 hover:bg-slate-100"
                      }`}
                    >
                      {networkLogos[net.id] ? (
                        <img src={networkLogos[net.id]} alt={net.name} className="w-12 h-12 object-contain mb-2" />
                      ) : (
                        <div className="w-12 h-12 bg-slate-200 rounded-full mb-2 flex items-center justify-center">
                           <span className="font-bold text-slate-500">{net.name[0]}</span>
                        </div>
                      )}
                      <span className={`text-xs font-black uppercase ${selectedNetwork === net.id ? "text-violet-700" : "text-slate-500"}`}>
                        {net.name}
                      </span>
                      {selectedNetwork === net.id && (
                        <div className="absolute -top-2 -right-2 bg-violet-600 text-white rounded-full p-1 shadow-md">
                          <CheckCircle2 className="w-3 h-3" />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Form Fields */}
              <div className="space-y-6">
                <Label className="text-slate-900 font-bold flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-violet-600" />
                  2. Order Details
                </Label>
                
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="customerName" className="text-slate-600">Full Name</Label>
                    <Input 
                      id="customerName"
                      placeholder="E.g John Doe"
                      className="bg-slate-50 border-slate-200 focus:ring-violet-500 focus:border-violet-500 rounded-xl"
                      value={formData.customerName}
                      onChange={e => setFormData({...formData, customerName: e.target.value})}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="customerEmail" className="text-slate-600">Email Address *</Label>
                    <Input 
                      id="customerEmail"
                      type="email"
                      required
                      placeholder="john@example.com"
                      className="bg-slate-50 border-slate-200 focus:ring-violet-500 focus:border-violet-500 rounded-xl"
                      value={formData.customerEmail}
                      onChange={e => setFormData({...formData, customerEmail: e.target.value})}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="phone" className="text-slate-600">Beneficiary Number *</Label>
                    <Input 
                      id="phone"
                      type="tel"
                      required
                      placeholder="024XXXXXXX"
                      className="bg-slate-50 border-slate-200 focus:ring-violet-500 focus:border-violet-500 rounded-xl font-mono text-lg"
                      value={formData.beneficiaryPhone}
                      onChange={e => setFormData({...formData, beneficiaryPhone: e.target.value})}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="amount" className="text-slate-600">Amount (GHS) *</Label>
                    <Input 
                      id="amount"
                      type="number"
                      min="1"
                      required
                      placeholder="10.00"
                      className="bg-slate-50 border-slate-200 focus:ring-violet-500 focus:border-violet-500 rounded-xl font-bold text-lg"
                      value={formData.amount}
                      onChange={e => setFormData({...formData, amount: e.target.value})}
                    />
                  </div>
                </div>
              </div>

              {/* Price Summary */}
              <div className="group relative">
                <div className="absolute -inset-1 bg-gradient-to-r from-violet-600 to-indigo-600 rounded-2xl blur opacity-25 group-hover:opacity-40 transition duration-1000"></div>
                <div className="relative p-6 bg-slate-50 rounded-2xl border border-slate-100">
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-slate-500 font-semibold">Base Amount:</span>
                    <span className="text-slate-900 font-bold">GHS {parseFloat(formData.amount || "0").toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between items-center mb-4 pb-4 border-b border-slate-200">
                    <span className="text-slate-500 font-semibold">Service Fee:</span>
                    <span className="text-violet-600 font-bold">
                       + GHS {(calculateTotal() - parseFloat(formData.amount || "0")).toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-900 text-lg font-black">Total to Pay:</span>
                    <div className="text-right">
                      <span className="text-3xl font-black bg-gradient-to-r from-violet-700 to-indigo-800 bg-clip-text text-transparent">
                        GHS {calculateTotal().toFixed(2)}
                      </span>
                      <p className="text-[10px] text-slate-400 mt-1 uppercase tracking-wider font-bold">No Paystack Surcharge</p>
                    </div>
                  </div>
                </div>
              </div>

              <Button 
                type="submit" 
                disabled={submitting || !selectedNetwork}
                className="w-full h-16 bg-gradient-to-r from-violet-600 via-indigo-700 to-purple-600 hover:scale-[1.02] active:scale-95 text-white text-xl font-black rounded-2xl shadow-xl shadow-violet-200 transition-all duration-300 disabled:opacity-50 disabled:grayscale"
              >
                {submitting ? (
                  <div className="flex items-center gap-3">
                    <Loader2 className="w-6 h-6 animate-spin" />
                    <span>Processing Securely...</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <CreditCard className="w-6 h-6" />
                    <span>Pay GHS {calculateTotal().toFixed(2)}</span>
                  </div>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Support Section */}
        <div className="mt-12 text-center space-y-4">
          <div className="flex items-center justify-center gap-6 grayscale opacity-60">
             <img src="/paystack-logo.png" alt="Paystack" className="h-4" />
          </div>
          <p className="text-xs text-slate-500 font-medium">Your connection is encrypted and payment is handled securely by Paystack.</p>
          <div className="pt-4">
             <Button variant="link" onClick={() => router.push(`/shop/${shopSlug}`)} className="text-violet-600 hover:text-violet-700 font-bold">
                Return to Storefront
             </Button>
          </div>
        </div>
      </main>
    </div>
  )
}

function Badge({ children, className }: { children: React.ReactNode, className?: string }) {
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border ${className}`}>
      {children}
    </span>
  )
}
