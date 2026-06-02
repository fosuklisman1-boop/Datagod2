"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CreditCard, Loader2, Zap, CheckCircle2, ShieldCheck, Copy, AlertCircle } from "lucide-react"
import { networkLogoService } from "@/lib/shop-service"
import { validatePhoneNumber } from "@/lib/phone-validation"
import { toast } from "sonner"
import TurnstileWidget from "@/components/shop/TurnstileWidget"
import HoneypotField from "@/components/shop/HoneypotField"
import { useResendCooldown } from "@/lib/use-resend-cooldown"

interface AirtimeStorefrontFormProps {
  shop: any
  shopSlug: string
}

export function AirtimeStorefrontForm({ shop, shopSlug }: AirtimeStorefrontFormProps) {
  const [submitting, setSubmitting] = useState(false)
  const [turnstileToken, setTurnstileToken] = useState<string>("")
  const [turnstileEnabled, setTurnstileEnabled] = useState<boolean>(true)
  const [honeypot, setHoneypot] = useState<string>("")
  // Checkout phone-OTP gate (verifies the PAYMENT number that gets charged)
  const [otpRequired, setOtpRequired] = useState<boolean>(false)
  const [paymentPhone, setPaymentPhone] = useState("")
  const [otpSent, setOtpSent] = useState(false)
  const [otpCode, setOtpCode] = useState("")
  const [otpVerified, setOtpVerified] = useState(false)
  const [sendingOtp, setSendingOtp] = useState(false)
  const [verifyingOtp, setVerifyingOtp] = useState(false)
  const otpCooldown = useResendCooldown(paymentPhone.replace(/\D/g, ""))
  // Live "approve the prompt" modal for the direct-charge flow
  const [momoModal, setMomoModal] = useState<null | { state: "awaiting" | "success" | "failed"; orderId?: string; summary?: any; message?: string }>(null)
  const [selectedNetwork, setSelectedNetwork] = useState<string | null>(null)
  const [networkLogos, setNetworkLogos] = useState<Record<string, string>>({})
  const [constraints, setConstraints] = useState<any>(null)
  const [paySeparately, setPaySeparately] = useState(true)
  const [availability, setAvailability] = useState<Record<string, boolean>>({
    MTN: true,
    Telecel: true,
    AT: true
  })
  
  const [formData, setFormData] = useState({
    customerName: "",
    customerEmail: "",
    beneficiaryPhone: "",
    amount: "10",
  })

  useEffect(() => {
    loadNetworkLogos()
    checkAllAvailability()
    // Fetch checkout requirements (Turnstile + OTP gate)
    fetch("/api/public/turnstile-status")
      .then(r => r.ok ? r.json() : { enabled: true, otp_required: false })
      .then(d => { setTurnstileEnabled(d.enabled !== false); setOtpRequired(d.otp_required === true) })
      .catch(() => { setTurnstileEnabled(true); setOtpRequired(false) })
  }, [])

  // One-time OTP: auto-skip the step if the PAYMENT number was already verified.
  useEffect(() => {
    if (!otpRequired || otpVerified) return
    const phone = paymentPhone.replace(/\D/g, "")
    if (!/^0?\d{9}$/.test(phone)) return
    const t = setTimeout(() => {
      fetch("/api/public/phone-verified", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: paymentPhone }),
      }).then(r => r.ok ? r.json() : { verified: false }).then(d => { if (d.verified) setOtpVerified(true) }).catch(() => {})
    }, 600)
    return () => clearTimeout(t)
  }, [paymentPhone, otpRequired, otpVerified])

  const handleSendOtp = async () => {
    const digits = paymentPhone.replace(/\D/g, "")
    if (!/^0?\d{9}$/.test(digits)) { toast.error("Enter a valid Mobile Money number first"); return }
    setSendingOtp(true)
    try {
      const res = await fetch("/api/auth/send-phone-otp", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: paymentPhone }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(d?.error || "Failed to send code"); return }
      toast.success("Verification code sent"); setOtpSent(true); otpCooldown.start()
    } catch { toast.error("Network error") } finally { setSendingOtp(false) }
  }

  const handleVerifyOtp = async () => {
    if (!otpCode || otpCode.length < 4) { toast.error("Enter the code from your SMS"); return }
    setVerifyingOtp(true)
    try {
      const res = await fetch("/api/auth/verify-phone-otp", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: paymentPhone, code: otpCode.trim() }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.verified) { toast.error(d?.error || "Incorrect code"); return }
      toast.success("Payment number verified ✓"); setOtpVerified(true)
    } catch { toast.error("Network error") } finally { setVerifyingOtp(false) }
  }

  // Poll airtime order status while the live MoMo prompt modal is open.
  const pollMomoStatus = (orderId: string, summary: any) => {
    const started = Date.now()
    const TIMEOUT_MS = 4 * 60 * 1000
    const tick = async () => {
      if (Date.now() - started > TIMEOUT_MS) {
        setMomoModal({ state: "failed", message: "Payment timed out. If you approved the prompt, your order will still be processed — check your orders, or try again." })
        return
      }
      try {
        const res = await fetch(`/api/payments/momo-status?orderId=${orderId}&orderType=airtime`)
        const d = await res.json().catch(() => ({ status: "pending" }))
        if (d.status === "completed") { setMomoModal({ state: "success", orderId, summary }); return }
        if (d.status === "failed") { setMomoModal({ state: "failed", message: "Payment was not completed. Please try again." }); return }
      } catch { /* keep polling */ }
      setTimeout(tick, 3000)
    }
    setTimeout(tick, 3000)
  }

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

  const checkAllAvailability = async () => {
    try {
      // Just fetch one network to get the 'allAvailability' map for all 3
      const res = await fetch(`/api/shop/airtime/public-constraints?slug=${shopSlug}&network=MTN`)
      if (res.ok) {
        const data = await res.json()
        if (data.allAvailability) {
          setAvailability(data.allAvailability)
        }
      }
    } catch (e) {
      console.error(`Error checking availability:`, e)
    }
  }

  const loadConstraints = async () => {
    try {
      const res = await fetch(`/api/shop/airtime/public-constraints?slug=${shopSlug}&network=${selectedNetwork}`)
      const data = await res.json()
      if (res.ok) {
        setConstraints(data)
        if (data.allAvailability) {
          setAvailability(data.allAvailability)
        }
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

    if (otpRequired && !otpVerified) {
      toast.error("Please verify your Mobile Money number first")
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
          // When the gate is on, this is the OTP-verified number we charge.
          paymentPhone: otpRequired ? paymentPhone : undefined,
          network: selectedNetwork,
          amount: formData.amount,
          paySeparately: paySeparately,
          totalPrice: totalPrice,
          turnstileToken,
          website: honeypot,
        })
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to initialize order")

      // ── Direct MoMo charge path (checkout OTP gate ON) ───────────────────
      // Charge the verified payment number directly and keep the buyer on-page
      // with a live modal that polls until the webhook confirms the prompt.
      if (otpRequired) {
        const summary = {
          packageLabel: `${selectedNetwork} airtime`,
          beneficiary: phoneVal.normalized,
          paymentPhone,
          amount: totalPrice,
        }
        const chargeRes = await fetch("/api/payments/initialize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amount: totalPrice,
            email: formData.customerEmail,
            orderId: data.orderId,
            orderType: "airtime",
            shopSlug,
            momoDirect: true,
            paymentPhone,
          })
        })
        const chargeData = await chargeRes.json().catch(() => ({}))
        if (!chargeRes.ok || !chargeData.success) {
          throw new Error(chargeData?.error || "Could not start the Mobile Money charge. Please try again.")
        }
        setMomoModal({ state: "awaiting", orderId: data.orderId, summary })
        pollMomoStatus(data.orderId, { ...summary, reference: chargeData.reference })
        return
      }

      // Initialize Paystack payment (hosted redirect — gate OFF)
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

  return (
    <>
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
              {networks.map((net) => {
                const isAvail = availability[net.id] !== false
                return (
                  <button
                    key={net.id}
                    type="button"
                    disabled={!isAvail}
                    onClick={() => setSelectedNetwork(net.id)}
                    className={`relative flex flex-col items-center justify-center p-4 rounded-xl border-2 transition-all duration-300 ${
                      selectedNetwork === net.id
                        ? "border-violet-600 bg-violet-50 ring-4 ring-violet-100 shadow-lg scale-[1.05]"
                        : isAvail 
                          ? "border-slate-100 bg-slate-50 hover:border-violet-200 hover:bg-slate-100"
                          : "border-slate-50 bg-slate-50/50 grayscale opacity-60 cursor-not-allowed"
                    }`}
                  >
                    {!isAvail && (
                      <div className="absolute top-1 right-1 bg-red-100 text-red-600 text-[8px] font-black px-1 rounded-sm border border-red-200">
                        OOS
                      </div>
                    )}
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
                )
              })}
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
                  onChange={e => {
                    setFormData({...formData, beneficiaryPhone: e.target.value})
                    if (otpSent || otpVerified) { setOtpSent(false); setOtpVerified(false); setOtpCode("") }
                  }}
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

          <HoneypotField value={honeypot} onChange={setHoneypot} />

          {/* Payment-number + OTP step (only when admin gate is ON). The number
              entered here is the one Paystack charges directly, so the prompt can
              only ever reach a number the buyer verified. */}
          {otpRequired && (
            <div className="p-4 rounded-2xl bg-purple-50 border border-purple-200 space-y-3">
              <div className="space-y-2">
                <Label className="text-sm font-semibold text-purple-900">Mobile Money number to pay from *</Label>
                <Input
                  type="tel"
                  inputMode="numeric"
                  placeholder="0241234567"
                  value={paymentPhone}
                  onChange={e => {
                    setPaymentPhone(e.target.value)
                    if (otpSent || otpVerified) { setOtpSent(false); setOtpVerified(false); setOtpCode(""); otpCooldown.reset() }
                  }}
                  disabled={otpVerified}
                  className="bg-white border-purple-200 rounded-xl font-mono"
                />
                <p className="text-xs text-purple-700">The payment prompt is sent to this number. You verify it once.</p>
              </div>

              {!otpVerified ? (
                !otpSent ? (
                  <Button type="button" onClick={handleSendOtp} disabled={sendingOtp || otpCooldown.seconds > 0} className="w-full bg-purple-600 hover:bg-purple-700 text-white rounded-xl">
                    {sendingOtp ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending code…</>) : otpCooldown.seconds > 0 ? `Resend in ${otpCooldown.seconds}s` : "Send verification code"}
                  </Button>
                ) : (
                  <div className="space-y-2">
                    <Input inputMode="numeric" maxLength={6} placeholder="Enter 6-digit code" value={otpCode}
                      onChange={e => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      className="text-center text-lg tracking-[0.4em] font-mono bg-white" />
                    <div className="flex gap-2">
                      <Button type="button" onClick={handleVerifyOtp} disabled={verifyingOtp || otpCode.length < 4} className="flex-1 bg-purple-600 hover:bg-purple-700 text-white rounded-xl">
                        {verifyingOtp ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying…</>) : "Verify"}
                      </Button>
                      <Button type="button" variant="outline" onClick={handleSendOtp} disabled={sendingOtp || otpCooldown.seconds > 0}>{otpCooldown.seconds > 0 ? `Resend in ${otpCooldown.seconds}s` : "Resend"}</Button>
                    </div>
                  </div>
                )
              ) : (
                <div className="p-3 rounded-xl bg-green-50 border border-green-200 flex items-center gap-2">
                  <CheckCircle2 className="w-5 h-5 text-green-600" />
                  <span className="text-sm font-medium text-green-900">Payment number verified ✓</span>
                </div>
              )}
            </div>
          )}

          {turnstileEnabled && (
            <div className="flex justify-center">
              <TurnstileWidget onToken={setTurnstileToken} onExpire={() => setTurnstileToken("")} />
            </div>
          )}

          <Button
            type="submit"
            disabled={submitting || !selectedNetwork || (turnstileEnabled && !turnstileToken) || (otpRequired && !otpVerified)}
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

    {/* Live Mobile Money prompt modal (direct-charge flow). */}
    {momoModal && (
      <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-[60]">
        <Card className="w-full max-w-md bg-white rounded-2xl">
          {momoModal.state === "awaiting" && (
            <CardContent className="pt-8 pb-6 text-center space-y-4">
              <div className="mx-auto w-16 h-16 rounded-full bg-purple-100 flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-purple-600 animate-spin" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-900">Approve the prompt on your phone</h3>
                <p className="text-sm text-gray-600 mt-1">
                  We sent a Mobile Money prompt to{" "}
                  <span className="font-semibold">{momoModal.summary?.paymentPhone}</span>. Enter your PIN to approve the payment of{" "}
                  <span className="font-semibold">GHS {Number(momoModal.summary?.amount || 0).toFixed(2)}</span>.
                </p>
              </div>
              <div className="flex items-center justify-center gap-2 text-xs text-gray-500">
                <Loader2 className="w-3 h-3 animate-spin" /> Waiting for confirmation…
              </div>
              <p className="text-xs text-gray-400">Keep this page open. This can take up to a minute.</p>
            </CardContent>
          )}

          {momoModal.state === "success" && (
            <CardContent className="pt-8 pb-6 text-center space-y-4">
              <div className="mx-auto w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
                <CheckCircle2 className="w-9 h-9 text-green-600" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-900">Payment successful 🎉</h3>
                <p className="text-sm text-gray-600 mt-1">Your airtime order is confirmed and is being processed.</p>
              </div>
              <div className="text-left p-4 rounded-lg bg-gray-50 border border-gray-200 space-y-1.5 text-sm">
                <div className="flex justify-between"><span className="text-gray-500">Item</span><span className="font-medium">{momoModal.summary?.packageLabel}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Recipient</span><span className="font-medium">{momoModal.summary?.beneficiary}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Paid from</span><span className="font-medium">{momoModal.summary?.paymentPhone}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Amount</span><span className="font-bold">GHS {Number(momoModal.summary?.amount || 0).toFixed(2)}</span></div>
                {momoModal.summary?.reference && (
                  <div className="flex justify-between"><span className="text-gray-500">Reference</span><span className="font-mono text-xs">{momoModal.summary.reference}</span></div>
                )}
              </div>
              <Button
                onClick={() => {
                  setMomoModal(null)
                  setFormData({ customerName: "", customerEmail: "", beneficiaryPhone: "", amount: "10" })
                  setPaymentPhone(""); setOtpSent(false); setOtpVerified(false); setOtpCode(""); setSelectedNetwork(null)
                }}
                className="w-full bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 rounded-xl"
              >
                Done
              </Button>
            </CardContent>
          )}

          {momoModal.state === "failed" && (
            <CardContent className="pt-8 pb-6 text-center space-y-4">
              <div className="mx-auto w-16 h-16 rounded-full bg-red-100 flex items-center justify-center">
                <AlertCircle className="w-9 h-9 text-red-600" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-900">Payment not completed</h3>
                <p className="text-sm text-gray-600 mt-1">{momoModal.message || "The prompt was not approved. Please try again."}</p>
              </div>
              <Button variant="outline" onClick={() => setMomoModal(null)} className="w-full rounded-xl">Close</Button>
            </CardContent>
          )}
        </Card>
      </div>
    )}
    </>
  )
}
