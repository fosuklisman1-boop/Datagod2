"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Loader2, CheckCircle2, Circle, ArrowRight } from "lucide-react"
import { networkLogoService } from "@/lib/shop-service"
import { validatePhoneNumber } from "@/lib/phone-validation"
import { toast } from "sonner"
import TurnstileWidget from "@/components/shop/TurnstileWidget"
import HoneypotField from "@/components/shop/HoneypotField"
import { useResendCooldown } from "@/lib/use-resend-cooldown"
import { PaymentSheet } from "@/components/shop/PaymentSheet"

// Same quick-amount set as the dashboard's Buy Airtime page (app/dashboard/airtime/page.tsx)
const QUICK_AMOUNTS = [1, 2, 5, 10, 20, 50]

interface AirtimeStorefrontFormProps {
  shop: any
  shopSlug: string
}

export function AirtimeStorefrontForm({ shop, shopSlug }: AirtimeStorefrontFormProps) {
  const [submitting, setSubmitting] = useState(false)
  const [turnstileToken, setTurnstileToken] = useState<string>("")
  const [turnstileEnabled, setTurnstileEnabled] = useState<boolean>(true)
  const [honeypot, setHoneypot] = useState<string>("")
  // Checkout phone-OTP gate (verifies the PAYMENT number that gets charged).
  // Direct charge is an INDEPENDENT toggle: pay on-page via momoDirect vs the
  // hosted Paystack redirect, regardless of whether OTP is required.
  const [otpRequired, setOtpRequired] = useState<boolean>(false)
  const [directCharge, setDirectCharge] = useState<boolean>(false)
  const [paymentPhone, setPaymentPhone] = useState("")
  const [otpSent, setOtpSent] = useState(false)
  const [otpCode, setOtpCode] = useState("")
  const [otpVerified, setOtpVerified] = useState(false)
  const [sendingOtp, setSendingOtp] = useState(false)
  const [verifyingOtp, setVerifyingOtp] = useState(false)
  const otpCooldown = useResendCooldown(paymentPhone.replace(/\D/g, ""))
  // Live payment sheet for the direct-charge flow -- same persistent bottom
  // sheet + state machine as the Data checkout (app/shop/[slug]/page.tsx).
  const [momoModal, setMomoModal] = useState<null | { state: "sending" | "awaiting" | "otp" | "success" | "failed"; orderId?: string; reference?: string; summary?: any; message?: string }>(null)
  const [momoOtpInput, setMomoOtpInput] = useState("")
  const [momoOtpSubmitting, setMomoOtpSubmitting] = useState(false)
  // Guards against in-flight order-init/charge-initialize/poll/OTP calls
  // resolving AFTER the customer already dismissed the sheet, reopening a
  // stale view on a sheet they already closed.
  const paymentDismissedRef = useRef(false)
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
      .then(r => r.ok ? r.json() : { enabled: true, otp_required: false, direct_charge: false })
      .then(d => { setTurnstileEnabled(d.enabled !== false); setOtpRequired(d.otp_required === true); setDirectCharge(d.direct_charge === true) })
      .catch(() => { setTurnstileEnabled(true); setOtpRequired(false); setDirectCharge(false) })
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

  // Poll airtime order status while the sheet's live MoMo view is showing.
  const pollMomoStatus = (orderId: string, summary: any) => {
    const started = Date.now()
    const TIMEOUT_MS = 4 * 60 * 1000
    const tick = async () => {
      if (paymentDismissedRef.current) return
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

  // Submit the OTP Paystack sent for a Telecel Cash direct charge. Success only
  // means the code was accepted — the payment itself still completes via the
  // charge.success webhook, which pollMomoStatus (already running) picks up.
  const submitMomoOtp = async () => {
    if (!momoModal || momoModal.state !== "otp" || !momoOtpInput.trim()) return
    setMomoOtpSubmitting(true)
    try {
      const res = await fetch("/api/payments/submit-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference: momoModal.reference, otp: momoOtpInput.trim(), orderId: momoModal.orderId, orderType: "airtime" }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        toast.error(data.error || "That code was rejected. Please try again.")
        setMomoOtpSubmitting(false)
        return
      }
      if (!paymentDismissedRef.current) {
        setMomoModal({ state: "awaiting", orderId: momoModal.orderId, reference: momoModal.reference, summary: momoModal.summary })
      }
      setMomoOtpInput("")
      setMomoOtpSubmitting(false)
    } catch {
      toast.error("Could not submit the code. Please try again.")
      setMomoOtpSubmitting(false)
    }
  }

  useEffect(() => {
    // NB: shop comes from getShopBySlug, which does not select the `id`
    // column (see lib/shop-service.ts) -- gating on shop?.id here meant this
    // never fired, constraints stayed null forever, and every fee/total
    // calculation silently short-circuited to the raw amount regardless of
    // the "Pay fee separately" toggle. loadConstraints only needs shopSlug
    // (already a required prop) and selectedNetwork.
    if (selectedNetwork) {
      loadConstraints()
    }
  }, [selectedNetwork])

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

    if (otpRequired && !otpVerified) {
      toast.error("Please verify your Mobile Money number first")
      return
    }
    if (directCharge && !otpRequired && !/^0?\d{9}$/.test(paymentPhone.replace(/\D/g, ""))) {
      toast.error("Enter a valid Mobile Money number to pay from")
      return
    }

    // Direct-charge orders take two sequential network round-trips (init
    // order, then initialize the charge) before a MoMo prompt actually
    // reaches the phone. Show the sheet's "sending" view immediately on
    // submit instead of leaving the customer watching the button spinner.
    if (directCharge) {
      paymentDismissedRef.current = false
      setMomoModal({ state: "sending" })
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
          // The MoMo number we charge on-page (direct charge) and/or OTP-verify.
          paymentPhone: (otpRequired || directCharge) ? paymentPhone : undefined,
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

      // ── Direct MoMo charge path (direct-charge toggle ON) ────────────────
      // Charge the on-page payment number directly and keep the buyer on-page
      // with a live modal that polls until the webhook confirms the prompt.
      if (directCharge) {
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
        // Customer already dismissed the sheet before this resolved -- the
        // charge may still have fired (the webhook completes the order
        // regardless), but don't reopen a view they already closed.
        if (paymentDismissedRef.current) return
        setMomoModal({ state: chargeData.status === "send_otp" ? "otp" : "awaiting", orderId: data.orderId, reference: chargeData.reference, summary })
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
      // A toast alone would be easy to miss behind the sheet's "sending"
      // view, so surface direct-charge failures inside it instead -- unless
      // the customer already dismissed the sheet themselves. Can't gate this
      // on `momoModal?.state === "sending"`: that reads the binding this
      // closure captured at call-start, which the earlier setMomoModal never
      // updates (state setters don't mutate a running closure's locals).
      // `directCharge` alone already implies we showed "sending" this call.
      if (directCharge && !paymentDismissedRef.current) {
        setMomoModal({ state: "failed", message: error.message })
      } else if (!directCharge || !paymentDismissedRef.current) {
        toast.error(error.message)
      }
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
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Network -- same card style as the dashboard's Buy Airtime picker */}
      <div className="space-y-2">
        <p className="text-sm font-bold text-foreground">Network</p>
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          {networks.map((net) => {
            const isAvail = availability[net.id] !== false
            const isSelected = selectedNetwork === net.id
            return (
              <button
                key={net.id}
                type="button"
                disabled={!isAvail}
                onClick={() => setSelectedNetwork(net.id)}
                className={`relative flex flex-col items-center gap-1.5 sm:gap-2 rounded-2xl border-2 bg-card p-2.5 sm:p-4 transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  isSelected ? "border-[var(--shop-accent)] shadow-sm" : "border-border hover:border-[var(--shop-accent)]/30"
                } clay`}
              >
                {!isAvail && (
                  <span className="absolute right-1 top-1 rounded-sm border border-border bg-destructive/15 px-1 text-[8px] font-black text-destructive">OOS</span>
                )}
                {isSelected && (
                  <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-success text-white">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  </span>
                )}
                {networkLogos[net.id] ? (
                  net.id === "Telecel" ? (
                    // Telecel's logo art crops badly under object-cover (zooms in
                    // past the wordmark) -- kept inset/contain for this network only.
                    <span className="grid h-11 w-11 sm:h-14 sm:w-14 place-items-center rounded-full bg-muted">
                      <img src={networkLogos[net.id]} alt={net.name} className="h-8 w-8 sm:h-9 sm:w-9 object-contain" />
                    </span>
                  ) : (
                    <span className="block h-11 w-11 sm:h-14 sm:w-14 overflow-hidden rounded-full bg-card">
                      <img src={networkLogos[net.id]} alt={net.name} className="h-full w-full object-cover" />
                    </span>
                  )
                ) : (
                  <span className="flex h-11 w-11 sm:h-14 sm:w-14 items-center justify-center rounded-full bg-muted text-sm font-extrabold text-muted-foreground">
                    {net.name[0]}
                  </span>
                )}
                <span className="text-xs sm:text-sm font-bold text-foreground">{net.name}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Order Details */}
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <p className="text-sm font-bold text-foreground">Full Name</p>
            <Input
              placeholder="E.g John Doe"
              className="rounded-2xl border-border bg-card py-3.5"
              value={formData.customerName}
              onChange={e => setFormData({...formData, customerName: e.target.value})}
            />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-bold text-foreground">Email Address *</p>
            <Input
              type="email"
              required
              placeholder="john@example.com"
              className="rounded-2xl border-border bg-card py-3.5"
              value={formData.customerEmail}
              onChange={e => setFormData({...formData, customerEmail: e.target.value})}
            />
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-bold text-foreground">Beneficiary Number *</p>
          <Input
            type="tel"
            required
            placeholder="024XXXXXXX"
            className="rounded-2xl border-border bg-card py-3.5 font-mono text-base"
            value={formData.beneficiaryPhone}
            onChange={e => {
              setFormData({...formData, beneficiaryPhone: e.target.value})
              if (otpSent || otpVerified) { setOtpSent(false); setOtpVerified(false); setOtpCode("") }
            }}
          />
        </div>

        <div className="space-y-2">
          <p className="text-sm font-bold text-foreground">Quick amount (GHS)</p>
          <div className="flex flex-wrap items-center gap-2">
            {QUICK_AMOUNTS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setFormData({...formData, amount: String(v)})}
                className={`rounded-full border px-4 py-2 text-sm font-bold transition ${
                  formData.amount === String(v) ? "border-[var(--shop-accent)] bg-[var(--shop-accent)] text-white" : "border-border bg-card text-foreground hover:border-[var(--shop-accent)]/30"
                } clay-sm`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-bold text-foreground">Custom amount (GHS) *</p>
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm font-semibold text-muted-foreground">GHS</span>
            <Input
              type="number"
              min="1"
              required
              placeholder="0.00"
              className="rounded-2xl border-border bg-card py-3.5 pl-14 text-lg font-semibold"
              value={formData.amount}
              onChange={e => setFormData({...formData, amount: e.target.value})}
            />
          </div>
        </div>
      </div>

      {/* Pay fee separately -- same toggle card style as the dashboard */}
      <button
        type="button"
        onClick={() => setPaySeparately(!paySeparately)}
        className={`flex w-full items-start gap-3 rounded-2xl border p-4 text-left transition ${
          paySeparately ? "border-[#75beab]/40 bg-[#e9f4f1]" : "border-border bg-card"
        }`}
      >
        {paySeparately ? (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[#0f7a4d]" />
        ) : (
          <Circle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        )}
        <span>
          <span className={`block text-sm font-bold ${paySeparately ? "text-[#0f7a4d]" : "text-foreground"}`}>
            Pay fee separately
          </span>
          <span className={`mt-0.5 block text-xs ${paySeparately ? "text-[#0f7a4d]/80" : "text-muted-foreground"}`}>
            {paySeparately
              ? "Recipient gets the full amount; service fee is added to your total."
              : "Service fee is deducted from the amount before delivery."}
          </span>
        </span>
      </button>

      {/* Fee breakdown -- same layout as the dashboard */}
      {parseFloat(formData.amount || "0") > 0 && (
        <div className="space-y-2 rounded-2xl border border-white/60 dark:border-white/5 bg-card p-4 text-sm clay">
          <div className="flex justify-between text-muted-foreground">
            <span>Recipient gets</span>
            <span className="font-semibold text-foreground">GHS {calculateRecipientGets().toFixed(2)}</span>
          </div>
          {constraints && (
            <div className="flex justify-between text-muted-foreground">
              <span>Service fee {paySeparately ? "(added on top)" : "(deducted from amount)"}</span>
              <span>GHS {calculateFeeAmount().toFixed(2)}</span>
            </div>
          )}
          <div className="flex justify-between border-t border-border pt-2 font-bold text-foreground">
            <span>You pay</span>
            <span>GHS {calculateTotal().toFixed(2)}</span>
          </div>
        </div>
      )}

      <HoneypotField value={honeypot} onChange={setHoneypot} />

      {/* Payment-number step. Shown when OTP verification OR direct charge is
          on — both need the on-page MoMo number. OTP controls render only when
          OTP is required; with direct charge alone the number is charged as typed. */}
      {(otpRequired || directCharge) && (
        <div className="space-y-3 rounded-2xl border border-white/60 dark:border-white/5 bg-card p-4 clay">
          <div className="space-y-2">
            <p className="text-sm font-bold text-foreground">Mobile Money number to pay from *</p>
            <Input
              type="tel"
              inputMode="numeric"
              placeholder="0241234567"
              value={paymentPhone}
              onChange={e => {
                setPaymentPhone(e.target.value)
                if (otpSent || otpVerified) { setOtpSent(false); setOtpVerified(false); setOtpCode(""); otpCooldown.reset() }
              }}
              disabled={otpRequired && otpVerified}
              className="rounded-2xl border-border bg-card py-3.5 font-mono"
            />
            <p className="text-xs text-muted-foreground">
              {otpRequired ? "The payment prompt is sent to this number. You verify it once." : "The payment prompt is sent to this number."}
            </p>
          </div>

          {otpRequired && (!otpVerified ? (
            !otpSent ? (
              <Button type="button" onClick={handleSendOtp} disabled={sendingOtp || otpCooldown.seconds > 0} className="w-full rounded-2xl bg-[var(--shop-accent)] text-white hover:bg-[var(--shop-accent)]/90">
                {sendingOtp ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending code…</>) : otpCooldown.seconds > 0 ? `Resend in ${otpCooldown.seconds}s` : "Send verification code"}
              </Button>
            ) : (
              <div className="space-y-2">
                <Input inputMode="numeric" maxLength={6} placeholder="Enter 6-digit code" value={otpCode}
                  onChange={e => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  className="rounded-2xl bg-card text-center text-lg font-mono tracking-[0.4em]" />
                <div className="flex gap-2">
                  <Button type="button" onClick={handleVerifyOtp} disabled={verifyingOtp || otpCode.length < 4} className="flex-1 rounded-2xl bg-[var(--shop-accent)] text-white hover:bg-[var(--shop-accent)]/90">
                    {verifyingOtp ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying…</>) : "Verify"}
                  </Button>
                  <Button type="button" variant="outline" onClick={handleSendOtp} disabled={sendingOtp || otpCooldown.seconds > 0} className="rounded-2xl">{otpCooldown.seconds > 0 ? `Resend in ${otpCooldown.seconds}s` : "Resend"}</Button>
                </div>
                <p className="text-xs text-muted-foreground">📩 Don&apos;t see the code? Check your phone&apos;s Spam or Blocked messages folder.</p>
              </div>
            )
          ) : (
            <div className="flex items-center gap-2 rounded-2xl border border-border bg-success/10 p-3">
              <CheckCircle2 className="w-5 h-5 text-success" />
              <span className="text-sm font-medium text-success">Payment number verified ✓</span>
            </div>
          ))}
        </div>
      )}

      {turnstileEnabled && (
        <div className="flex justify-center">
          <TurnstileWidget onToken={setTurnstileToken} onExpire={() => setTurnstileToken("")} />
        </div>
      )}

      <Button
        type="submit"
        disabled={submitting || !selectedNetwork || (turnstileEnabled && !turnstileToken) || (otpRequired && !otpVerified) || (directCharge && !otpRequired && !/^0?\d{9}$/.test(paymentPhone.replace(/\D/g, "")))}
        className="flex w-full items-center justify-center gap-2 rounded-2xl bg-success py-4 text-base font-bold text-white hover:bg-success/90"
      >
        {submitting ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Processing...
          </>
        ) : (
          <>Proceed to payment <ArrowRight className="w-4 h-4" /></>
        )}
      </Button>
    </form>

    {/* Live Mobile Money prompt sheet (direct-charge flow) -- the same
        persistent bottom sheet the Data checkout uses, shared via
        components/shop/PaymentSheet.tsx. */}
    {momoModal && (
      <PaymentSheet
        modal={momoModal}
        onCancelSending={() => { paymentDismissedRef.current = true; setMomoModal(null) }}
        onDismiss={() => {
          paymentDismissedRef.current = true
          setMomoModal(null)
          setFormData({ customerName: "", customerEmail: "", beneficiaryPhone: "", amount: "10" })
          setPaymentPhone(""); setOtpSent(false); setOtpVerified(false); setOtpCode(""); setSelectedNetwork(null)
          setMomoOtpInput(""); setMomoOtpSubmitting(false)
        }}
        onRetry={() => { setMomoModal(null); setMomoOtpInput(""); setMomoOtpSubmitting(false) }}
        otpInput={momoOtpInput}
        setOtpInput={setMomoOtpInput}
        onSubmitOtp={submitMomoOtp}
        otpSubmitting={momoOtpSubmitting}
        renderSuccess={(modal) => (
          <div className="px-5 pb-6 pt-2 text-center space-y-4">
            <div className="mx-auto w-16 h-16 rounded-full bg-success/15 flex items-center justify-center">
              <CheckCircle2 className="w-9 h-9 text-success" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-foreground">Payment successful 🎉</h3>
              <p className="text-sm text-muted-foreground mt-1">Your airtime order is confirmed and is being processed.</p>
            </div>
            <div className="text-left p-4 rounded-2xl bg-muted/40 border border-border space-y-1.5 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Item</span><span className="font-medium">{modal.summary?.packageLabel}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Recipient</span><span className="font-medium">{modal.summary?.beneficiary}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Paid from</span><span className="font-medium">{modal.summary?.paymentPhone}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Amount</span><span className="font-bold">GHS {Number(modal.summary?.amount || 0).toFixed(2)}</span></div>
              {modal.summary?.reference && (
                <div className="flex justify-between"><span className="text-muted-foreground">Reference</span><span className="font-mono text-xs">{modal.summary.reference}</span></div>
              )}
            </div>
            <Button
              onClick={() => {
                setMomoModal(null)
                setFormData({ customerName: "", customerEmail: "", beneficiaryPhone: "", amount: "10" })
                setPaymentPhone(""); setOtpSent(false); setOtpVerified(false); setOtpCode(""); setSelectedNetwork(null)
              }}
              className="w-full rounded-2xl bg-success text-white hover:bg-success/90"
            >
              Done
            </Button>
          </div>
        )}
      />
    )}
    </>
  )
}
