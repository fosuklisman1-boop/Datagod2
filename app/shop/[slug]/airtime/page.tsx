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
import { useShopBasePath } from "@/lib/shop-url"
import { validatePhoneNumber } from "@/lib/phone-validation"
import { toast } from "sonner"

export default function ShopAirtimePage() {
  const params = useParams()
  const router = useRouter()
  const shopSlug = params.slug as string
  // "" on a subdomain host (keeps URL clean), "/shop/<slug>" on the main host.
  const shopHome = useShopBasePath(shopSlug) || "/"

  const [shop, setShop] = useState<any>(null)
  const [loading, setLoading] = useState(true)
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
    loadShop()
    loadNetworkLogos()
  }, [shopSlug])

  useEffect(() => {
    // getShopBySlug no longer exposes shop.id — gate on the shop object itself
    // (loadConstraints fetches by slug, so the id was never needed here).
    if (shop && selectedNetwork) {
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

  const calculateFeeAmount = () => {
    const amount = parseFloat(formData.amount || "0")
    if (isNaN(amount) || !constraints) return 0
    const baseFeePercent = constraints.baseFeePercent || 0
    const markupPercent = constraints.markupPercent || 0
    const totalFeePercent = baseFeePercent + markupPercent
    if (paySeparately) {
      return amount * totalFeePercent / 100
    } else {
      return amount * totalFeePercent / (100 + totalFeePercent)
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
          shopSlug: shopSlug,
          customerName: formData.customerName,
          customerEmail: formData.customerEmail,
          beneficiaryPhone: phoneVal.normalized,
          network: selectedNetwork,
          amount: formData.amount,
          paySeparately: paySeparately,
          totalPrice: totalPrice,
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
          orderId: data.orderId,
          orderType: "airtime",
          shopSlug,
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
      <div className="min-h-screen flex items-center justify-center bg-muted/40">
        <Loader2 className="w-10 h-10 animate-spin text-primary" />
      </div>
    )
  }

  if (!shop) {
    return (
      <div className="min-h-screen p-4 bg-muted/40 flex items-center justify-center">
        <Alert className="max-w-md border-border bg-destructive/10 shadow-lg">
          <AlertCircle className="w-4 h-4 text-destructive" />
          <AlertDescription className="text-destructive font-medium">Shop not found or inactive.</AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-card pb-20">
      {/* Header */}
      <nav className="bg-card/80 backdrop-blur-md border-b border-border shadow-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <button 
            onClick={() => router.push(shopHome)} 
            className="p-2 hover:bg-primary/10 text-foreground hover:text-primary rounded-xl transition-all"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
          <div className="flex items-center gap-3">
            <Store className="w-5 h-5 text-primary" />
            <h1 className="text-xl font-bold text-foreground truncate max-w-[180px] sm:max-w-none">
              {shop.shop_name}
            </h1>
          </div>
          {shop.logo_url ? (
            <img src={shop.logo_url} className="w-10 h-10 rounded-xl object-cover border border-border shadow-sm" alt="Logo" />
          ) : (
            <div className="w-10 h-10 bg-primary rounded-xl flex items-center justify-center">
              <Zap className="w-5 h-5 text-primary-foreground" />
            </div>
          )}
        </div>
      </nav>

      <main className="max-w-xl mx-auto px-4 pt-8">
        <Card className="border-0 shadow-2xl overflow-hidden rounded-2xl">
          <div className="h-2 bg-primary" />
          <CardHeader className="bg-card border-b border-border">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-2xl font-black text-foreground flex items-center gap-2">
                  <Zap className="w-6 h-6 text-primary fill-primary" />
                  Buy Airtime
                </CardTitle>
                <CardDescription className="text-muted-foreground font-medium mt-1">
                  Secure instant top-up for any network
                </CardDescription>
              </div>
              <Badge className="bg-success/15 text-success border-success/30">
                <ShieldCheck className="w-3 h-3 mr-1" />
                Verified
              </Badge>
            </div>
          </CardHeader>

          <CardContent className="pt-8 bg-card">
            <form onSubmit={handleSubmit} className="space-y-8">
              {/* Network Selection */}
              <div className="space-y-4">
                <Label className="text-foreground font-bold flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-primary" />
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
                          ? "border-primary bg-primary ring-4 ring-primary"
                          : "border-border bg-muted/40 hover:border-border hover:bg-muted"
                      }`}
                    >
                      {networkLogos[net.id] ? (
                        <img src={networkLogos[net.id]} alt={net.name} className="w-12 h-12 object-contain mb-2" />
                      ) : (
                        <div className="w-12 h-12 bg-muted rounded-full mb-2 flex items-center justify-center">
                           <span className="font-bold text-muted-foreground">{net.name[0]}</span>
                        </div>
                      )}
                      <span className={`text-xs font-black uppercase ${selectedNetwork === net.id ? "text-primary" : "text-muted-foreground"}`}>
                        {net.name}
                      </span>
                      {selectedNetwork === net.id && (
                        <div className="absolute -top-2 -right-2 bg-primary text-primary-foreground rounded-full p-1 shadow-md">
                          <CheckCircle2 className="w-3 h-3" />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Form Fields */}
              <div className="space-y-6">
                <Label className="text-foreground font-bold flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-primary" />
                  2. Order Details
                </Label>
                
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="customerName" className="text-muted-foreground">Full Name</Label>
                    <Input 
                      id="customerName"
                      placeholder="E.g John Doe"
                      className="bg-muted/40 border-border focus:ring-primary focus:border-primary rounded-xl"
                      value={formData.customerName}
                      onChange={e => setFormData({...formData, customerName: e.target.value})}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="customerEmail" className="text-muted-foreground">Email Address *</Label>
                    <Input 
                      id="customerEmail"
                      type="email"
                      required
                      placeholder="john@example.com"
                      className="bg-muted/40 border-border focus:ring-primary focus:border-primary rounded-xl"
                      value={formData.customerEmail}
                      onChange={e => setFormData({...formData, customerEmail: e.target.value})}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="phone" className="text-muted-foreground">Beneficiary Number *</Label>
                    <Input 
                      id="phone"
                      type="tel"
                      required
                      placeholder="024XXXXXXX"
                      className="bg-muted/40 border-border focus:ring-primary focus:border-primary rounded-xl font-mono text-lg"
                      value={formData.beneficiaryPhone}
                      onChange={e => setFormData({...formData, beneficiaryPhone: e.target.value})}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="amount" className="text-muted-foreground">Amount (GHS) *</Label>
                    <Input 
                      id="amount"
                      type="number"
                      min="1"
                      required
                      placeholder="10.00"
                      className="bg-muted/40 border-border focus:ring-primary focus:border-primary rounded-xl font-bold text-lg"
                      value={formData.amount}
                      onChange={e => setFormData({...formData, amount: e.target.value})}
                    />
                  </div>
                </div>
              </div>

              {/* Fee Toggle */}
              <div className="p-4 bg-primary rounded-2xl border border-border flex items-start gap-3 transition-all">
                <input
                  id="pay-sep"
                  type="checkbox"
                  checked={paySeparately}
                  onChange={(e) => setPaySeparately(e.target.checked)}
                  className="mt-1 h-5 w-5 text-primary border-border rounded focus:ring-primary cursor-pointer"
                />
                <label htmlFor="pay-sep" className="flex-1 cursor-pointer">
                  <span className="text-primary-foreground font-bold text-sm block">Pay fee separately</span>
                  <p className="text-primary-foreground/80 text-xs mt-1 leading-relaxed">
                    {paySeparately 
                      ? "Recipient gets the full amount; service fee is added to your total." 
                      : "Service fee is deducted from the amount before delivery."}
                  </p>
                </label>
              </div>

              {/* Price Summary */}
              <div className="group relative">
                <div className="absolute -inset-1 bg-primary rounded-2xl blur opacity-25 group-hover:opacity-40 transition duration-1000"></div>
                <div className="relative p-6 bg-muted/40 rounded-2xl border border-border">
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-muted-foreground font-semibold">Amount to Send:</span>
                    <span className="text-foreground font-bold">GHS {parseFloat(formData.amount || "0").toFixed(2)}</span>
                  </div>
                  {constraints && (
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-muted-foreground font-semibold">
                        Service Fee {paySeparately ? "(added on top)" : "(deducted from amount)"}:
                      </span>
                      <span className="text-warning font-bold">GHS {calculateFeeAmount().toFixed(2)}</span>
                    </div>
                  )}
                  <div className="flex justify-between items-center mb-4 pb-4 border-b border-border">
                    <span className="text-muted-foreground font-semibold">Recipient Gets:</span>
                    <span className="text-success font-black">
                       GHS {calculateRecipientGets().toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-foreground text-lg font-black">Total to Pay:</span>
                    <div className="text-right">
                      <span className="text-3xl font-black text-primary">
                        GHS {calculateTotal().toFixed(2)}
                      </span>
                      <p className="text-[10px] text-muted-foreground mt-1 uppercase tracking-wider font-bold">
                        {paySeparately ? "Amount + Service Fee" : "Fee Included in Amount"}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <Button 
                type="submit" 
                disabled={submitting || !selectedNetwork}
                className="w-full h-16 bg-primary hover:bg-primary/90 hover:scale-[1.02] active:scale-95 text-primary-foreground text-xl font-black rounded-2xl shadow-xl shadow-primary transition-all duration-300 disabled:opacity-50 disabled:grayscale"
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
          <p className="text-xs text-muted-foreground font-medium">Your connection is encrypted and payment is handled securely by Paystack.</p>
          <div className="pt-4">
             <Button variant="link" onClick={() => router.push(shopHome)} className="text-primary hover:text-primary font-bold">
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
