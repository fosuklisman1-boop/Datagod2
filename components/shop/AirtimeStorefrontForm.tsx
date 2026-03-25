"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CreditCard, Loader2, Zap, CheckCircle2, ShieldCheck } from "lucide-react"
import { networkLogoService } from "@/lib/shop-service"
import { validatePhoneNumber } from "@/lib/phone-validation"
import { toast } from "sonner"

interface AirtimeStorefrontFormProps {
  shop: any
  shopSlug: string
}

export function AirtimeStorefrontForm({ shop, shopSlug }: AirtimeStorefrontFormProps) {
  const [submitting, setSubmitting] = useState(false)
  const [selectedNetwork, setSelectedNetwork] = useState<string | null>(null)
  const [networkLogos, setNetworkLogos] = useState<Record<string, string>>({})
  const [constraints, setConstraints] = useState<any>(null)
  const [paySeparately, setPaySeparately] = useState(true)
  
  const [formData, setFormData] = useState({
    customerName: "",
    customerEmail: "",
    beneficiaryPhone: "",
    amount: "10",
  })

  useEffect(() => {
    loadNetworkLogos()
  }, [])

  useEffect(() => {
    if (shop?.id && selectedNetwork) {
      loadConstraints()
    }
  }, [shop, selectedNetwork])

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
      const res = await fetch(`/api/shop/airtime/public-constraints?slug=${shopSlug}&network=${selectedNetwork}`)
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

    if (paySeparately) {
      return amount + (amount * (totalFeePercent / 100))
    } else {
      return amount
    }
  }

  const calculateRecipientGets = () => {
    const amount = parseFloat(formData.amount || "0")
    if (isNaN(amount) || !constraints) return amount

    if (paySeparately) {
      return amount
    } else {
      const baseFeePercent = constraints.baseFeePercent || 0
      const markupPercent = constraints.markupPercent || 0
      const totalFeePercent = baseFeePercent + markupPercent
      
      const feeAmount = (amount * totalFeePercent / (100 + totalFeePercent))
      return amount - feeAmount
    }
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
          paySeparately: paySeparately,
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

  return (
    <Card className="border-0 shadow-2xl overflow-hidden rounded-2xl w-full max-w-xl mx-auto">
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
          <div className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border bg-green-100 text-green-700 border-green-200">
            <ShieldCheck className="w-3 h-3 mr-1" />
            Verified
          </div>
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

          {/* Fee Toggle */}
          <div className="p-4 bg-violet-50 rounded-2xl border border-violet-100 flex items-start gap-3 transition-all">
            <input
              id="pay-sep"
              type="checkbox"
              checked={paySeparately}
              onChange={(e) => setPaySeparately(e.target.checked)}
              className="mt-1 h-5 w-5 text-violet-600 border-gray-300 rounded focus:ring-violet-500 cursor-pointer"
            />
            <label htmlFor="pay-sep" className="flex-1 cursor-pointer">
              <span className="text-violet-900 font-bold text-sm block">Pay fee separately</span>
              <p className="text-violet-600 text-xs mt-1 leading-relaxed">
                {paySeparately 
                  ? "Recipient gets the full amount; service fee is added to your total." 
                  : "Service fee is deducted from the amount before delivery."}
              </p>
            </label>
          </div>

          {/* Price Summary */}
          <div className="group relative">
            <div className="absolute -inset-1 bg-gradient-to-r from-violet-600 to-indigo-600 rounded-2xl blur opacity-25 group-hover:opacity-40 transition duration-1000"></div>
            <div className="relative p-6 bg-slate-50 rounded-2xl border border-slate-100">
              <div className="flex justify-between items-center mb-1">
                <span className="text-slate-500 font-semibold">Amount to Send:</span>
                <span className="text-slate-900 font-bold">GHS {parseFloat(formData.amount || "0").toFixed(2)}</span>
              </div>
              <div className="flex justify-between items-center mb-4 pb-4 border-b border-slate-200">
                <span className="text-slate-500 font-semibold">Recipient Gets:</span>
                <span className="text-green-600 font-black">
                   GHS {calculateRecipientGets().toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-900 text-lg font-black">Total to Pay:</span>
                <div className="text-right">
                  <span className="text-3xl font-black bg-gradient-to-r from-violet-700 to-indigo-800 bg-clip-text text-transparent">
                    GHS {calculateTotal().toFixed(2)}
                  </span>
                  <p className="text-[10px] text-slate-400 mt-1 uppercase tracking-wider font-bold">Includes Service Fee</p>
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
  )
}
