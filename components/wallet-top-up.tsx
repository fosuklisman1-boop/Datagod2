"use client"

import { useState, useEffect, useRef } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Loader2, AlertCircle, CheckCircle, Zap } from "lucide-react"
import { initializePayment } from "@/lib/payment-service"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"
import { useResendCooldown } from "@/lib/use-resend-cooldown"
import { PaymentSheet } from "@/components/shop/PaymentSheet"

interface WalletTopUpProps {
  onSuccess?: (amount: number) => void
}

export function WalletTopUp({ onSuccess }: WalletTopUpProps) {
  const [amount, setAmount] = useState("")
  const [email, setEmail] = useState("")
  const [userId, setUserId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [paymentStatus, setPaymentStatus] = useState<"idle" | "processing" | "success" | "error">(
    "idle"
  )
  const [errorMessage, setErrorMessage] = useState("")
  const [paystackFeePercentage, setPaystackFeePercentage] = useState(3.0)

  // Wallet payment gates — OTP and direct charge are now INDEPENDENT toggles.
  //   • walletOtp    → the MoMo number must be SMS-OTP verified.
  //   • walletDirect → pay via the on-page direct MoMo charge (vs hosted redirect).
  const [walletOtp, setWalletOtp] = useState(false)
  const [walletDirect, setWalletDirect] = useState(false)
  const [paymentPhone, setPaymentPhone] = useState("")
  const [otpSent, setOtpSent] = useState(false)
  const [otpCode, setOtpCode] = useState("")
  const [otpVerified, setOtpVerified] = useState(false)
  const [sendingOtp, setSendingOtp] = useState(false)
  const [verifyingOtp, setVerifyingOtp] = useState(false)
  const otpCooldown = useResendCooldown(paymentPhone.replace(/\D/g, ""))
  const [momoModal, setMomoModal] = useState<null | { state: "sending" | "awaiting" | "otp" | "success" | "failed"; reference?: string; summary?: any; message?: string }>(null)
  const [momoOtpInput, setMomoOtpInput] = useState("")
  const [momoOtpSubmitting, setMomoOtpSubmitting] = useState(false)
  // Guards in-flight charge-init/poll/OTP calls from reopening a stale view
  // after the customer already dismissed the sheet themselves.
  const paymentDismissedRef = useRef(false)

  // Predefined amounts
  const quickAmounts = [50, 100, 200, 500]

  useEffect(() => {
    fetchUserInfo()
    fetchFeeSettings()
    // Wallet OTP + direct-charge gates (independent).
    fetch("/api/public/turnstile-status")
      .then(r => r.ok ? r.json() : { wallet_lock: false, wallet_direct_charge: false })
      .then(d => { setWalletOtp(d.wallet_lock === true); setWalletDirect(d.wallet_direct_charge === true) })
      .catch(() => { setWalletOtp(false); setWalletDirect(false) })
  }, [])

  // One-time OTP: auto-skip if the payment number was already verified.
  useEffect(() => {
    if (!walletOtp || otpVerified) return
    const digits = paymentPhone.replace(/\D/g, "")
    if (!/^0?\d{9}$/.test(digits)) return
    const t = setTimeout(() => {
      fetch("/api/public/phone-verified", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: paymentPhone }),
      }).then(r => r.ok ? r.json() : { verified: false }).then(d => { if (d.verified) setOtpVerified(true) }).catch(() => {})
    }, 600)
    return () => clearTimeout(t)
  }, [paymentPhone, walletOtp, otpVerified])

  const fetchFeeSettings = async () => {
    try {
      const response = await fetch("/api/settings/fees")
      if (response.ok) {
        const data = await response.json()
        setPaystackFeePercentage(data.paystack_fee_percentage || 3.0)
      }
    } catch (error) {
      console.error("[WALLET-TOPUP] Error fetching fee settings:", error)
      // Use default if fetch fails
      setPaystackFeePercentage(3.0)
    }
  }

  const fetchUserInfo = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        setUserId(user.id)
        setEmail(user.email || "")
      }
    } catch (error) {
      console.error("Error fetching user info:", error)
    }
  }

  const handleQuickAmount = (value: number) => {
    setAmount(value.toString())
  }

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

  // Poll wallet_payments status (by reference) while the live modal is open.
  const pollMomoStatus = (reference: string, summary: any) => {
    const started = Date.now()
    const TIMEOUT_MS = 4 * 60 * 1000
    const tick = async () => {
      if (paymentDismissedRef.current) return
      if (Date.now() - started > TIMEOUT_MS) {
        setMomoModal({ state: "failed", message: "Payment timed out. If you approved the prompt, your wallet will still be credited — refresh in a moment, or try again." })
        return
      }
      try {
        const res = await fetch(`/api/payments/momo-status?reference=${encodeURIComponent(reference)}`)
        const d = await res.json().catch(() => ({ status: "pending" }))
        if (d.status === "completed") {
          setMomoModal({ state: "success", reference, summary })
          if (onSuccess) onSuccess(parseFloat(amount))
          return
        }
        if (d.status === "failed") { setMomoModal({ state: "failed", message: "Payment was not completed. Please try again." }); return }
      } catch { /* keep polling */ }
      setTimeout(tick, 3000)
    }
    setTimeout(tick, 3000)
  }

  // Submit the OTP Paystack sent for a Telecel Cash direct charge. Success only
  // means the code was accepted — the top-up itself still completes via the
  // charge.success webhook, which pollMomoStatus (already running) picks up.
  const submitMomoOtp = async () => {
    if (!momoModal || momoModal.state !== "otp" || !momoOtpInput.trim()) return
    setMomoOtpSubmitting(true)
    try {
      const res = await fetch("/api/payments/submit-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference: momoModal.reference, otp: momoOtpInput.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        toast.error(data.error || "That code was rejected. Please try again.")
        setMomoOtpSubmitting(false)
        return
      }
      if (!paymentDismissedRef.current) {
        setMomoModal({ state: "awaiting", reference: momoModal.reference, summary: momoModal.summary })
      }
      setMomoOtpInput("")
      setMomoOtpSubmitting(false)
    } catch {
      toast.error("Could not submit the code. Please try again.")
      setMomoOtpSubmitting(false)
    }
  }

  const handleTopUp = async () => {
    // Validation
    const amountValue = parseFloat(amount)
    if (!amount || amountValue <= 0) {
      setErrorMessage("Please enter a valid amount")
      toast.error("Invalid amount")
      return
    }

    if (amountValue < 5) {
      setErrorMessage("Minimum top-up amount is 5 cedis")
      toast.error("Minimum top-up amount is 5 cedis")
      return
    }

    if (!email) {
      setErrorMessage("Email not found. Please refresh the page.")
      toast.error("Email not found")
      return
    }

    if (!userId) {
      setErrorMessage("User not found. Please log in again.")
      toast.error("User not found")
      return
    }

    // When OTP is required, the payment number must be verified first.
    if (walletOtp && !otpVerified) {
      setErrorMessage("Please verify your Mobile Money number first")
      toast.error("Verify your Mobile Money number first")
      return
    }
    // Direct charge (without OTP) still needs a valid number to charge on-page.
    if (walletDirect && !walletOtp && !/^0?\d{9}$/.test(paymentPhone.replace(/\D/g, ""))) {
      setErrorMessage("Enter a valid Mobile Money number to pay from")
      toast.error("Enter a valid Mobile Money number")
      return
    }

    // Direct-charge top-ups take two sequential network round-trips (this
    // function's own init call, awaited below) before a MoMo prompt actually
    // reaches the phone. Show the sheet's "sending" view immediately on
    // submit instead of leaving the customer watching the button spinner.
    if (walletDirect) {
      paymentDismissedRef.current = false
      setMomoModal({ state: "sending" })
    }
    try {
      setIsLoading(true)
      setPaymentStatus("processing")
      setErrorMessage("")

      console.log("[WALLET-TOPUP] Starting payment with amount:", amount)

      // ── Direct MoMo charge path (direct-charge gate ON) ──────────────────
      if (walletDirect) {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session?.access_token) { throw new Error("Your session expired. Please refresh and sign in again.") }
        const res = await fetch("/api/payments/initialize", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ amount: parseFloat(amount), email, momoDirect: true, paymentPhone }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.success) { throw new Error(data?.error || "Could not start the Mobile Money charge. Please try again.") }
        // Customer already dismissed the sheet before this resolved -- the
        // charge may still have fired (the webhook completes the top-up
        // regardless), but don't reopen a view they already closed.
        if (paymentDismissedRef.current) { setIsLoading(false); return }
        const summary = { amount: parseFloat(amount), paymentPhone, reference: data.reference }
        setMomoModal({ state: data.status === "send_otp" ? "otp" : "awaiting", reference: data.reference, summary })
        pollMomoStatus(data.reference, summary)
        setIsLoading(false)
        return
      }

      // Initialize payment (hosted redirect — gate OFF)
      const paymentResult = await initializePayment({
        amount: parseFloat(amount),
        email,
        userId,
      })

      console.log("[WALLET-TOPUP] Payment initialized:", paymentResult)

      // Redirect to Paystack checkout
      window.location.href = paymentResult.authorizationUrl
      setIsLoading(false)
    } catch (error) {
      console.error("[WALLET-TOPUP] Error:", error)
      const message = error instanceof Error ? error.message : "Payment initialization failed"
      // A toast alone would be easy to miss behind the sheet's "sending"
      // view, so surface direct-charge failures inside it instead -- unless
      // the customer already dismissed the sheet themselves.
      if (walletDirect && !paymentDismissedRef.current) {
        setMomoModal({ state: "failed", message })
      } else if (!walletDirect || !paymentDismissedRef.current) {
        setPaymentStatus("error")
        setErrorMessage(message)
        toast.error("Payment initialization failed")
      }
      setIsLoading(false)
    }
  }

  const handlePaymentSuccess = (reference: string) => {
    console.log("[WALLET-TOPUP] Payment successful with reference:", reference)
    setPaymentStatus("success")
    
    // Call success callback with amount
    if (onSuccess) {
      onSuccess(parseFloat(amount))
    }
    
    // Reset form
    setAmount("")
    setErrorMessage("")
    
    // Reset status after 3 seconds
    setTimeout(() => {
      setPaymentStatus("idle")
    }, 3000)
  }

  return (
    <div className="space-y-4">
      <Card className="w-full border-l-4 border-l-primary bg-card backdrop-blur-xl border border-border hover:border-border">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-primary" />
          Wallet Top Up
        </CardTitle>
        <CardDescription>Add funds to your wallet using Paystack</CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Error Alert */}
        {paymentStatus === "error" && errorMessage && (
          <Alert className="bg-destructive/10 border-border">
            <AlertCircle className="h-4 w-4 text-destructive" />
            <AlertDescription className="text-destructive">{errorMessage}</AlertDescription>
          </Alert>
        )}

        {/* Success Alert */}
        {paymentStatus === "success" && (
          <Alert className="bg-success/10 border-border">
            <CheckCircle className="h-4 w-4 text-success" />
            <AlertDescription className="text-success">
              Payment completed successfully! Your wallet has been credited.
            </AlertDescription>
          </Alert>
        )}

        {/* Amount Input */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Amount (GHS)</label>
          <Input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Enter amount"
            min="5"
            step="0.01"
            disabled={isLoading}
            className="text-lg"
          />
          <p className="text-xs text-muted-foreground">Minimum: GHS 5.00</p>
        </div>

        {/* Quick Amount Buttons */}
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">Quick amounts</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1 sm:gap-2">
            {quickAmounts.map((quickAmount) => (
              <Button
                key={quickAmount}
                variant="outline"
                onClick={() => handleQuickAmount(quickAmount)}
                disabled={isLoading}
                className="text-sm font-semibold hover:bg-primary hover:border-primary"
              >
                GHS {quickAmount}
              </Button>
            ))}
          </div>
        </div>

        {/* Email Display */}
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">Email</p>
          <div className="flex items-center gap-2 p-3 bg-card/40 backdrop-blur border border-border rounded-lg">
            <span className="text-sm text-muted-foreground">{email || "Loading..."}</span>
          </div>
        </div>

        {/* Fee Breakdown */}
        {amount && parseFloat(amount) > 0 && (
          <div className="p-4 bg-card border border-white/60 dark:border-white/5 rounded-lg space-y-2 clay">
            <p className="text-sm font-medium text-foreground">Payment Summary</p>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>Wallet Top Up:</span>
                <span>GHS {parseFloat(amount || "0").toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-warning">
                <span>Paystack Fee ({paystackFeePercentage}%):</span>
                <span>GHS {(parseFloat(amount || "0") * paystackFeePercentage / 100).toFixed(2)}</span>
              </div>
              <div className="pt-1 border-t border-border flex justify-between font-semibold text-foreground">
                <span>Total Amount:</span>
                <span>GHS {(parseFloat(amount || "0") * (1 + paystackFeePercentage / 100)).toFixed(2)}</span>
              </div>
            </div>
            <p className="text-xs text-warning mt-2">The {paystackFeePercentage}% fee is charged by Paystack for payment processing.</p>
          </div>
        )}

        {/* Payment Status Badge */}
        {paymentStatus !== "idle" && (
          <div className="flex items-center gap-2">
            <Badge
              className={
                paymentStatus === "success"
                  ? "bg-success/15 text-success"
                  : paymentStatus === "error"
                    ? "bg-destructive/15 text-destructive"
                    : "bg-primary/10 text-primary"
              }
            >
              {paymentStatus === "success"
                ? "✓ Payment Successful"
                : paymentStatus === "error"
                  ? "✗ Payment Failed"
                  : "◈ Processing Payment"}
            </Badge>
          </div>
        )}

        {/* Payment-number step. Shown when OTP verification OR direct charge is
            on — both need the on-page MoMo number. OTP controls render only when
            OTP is required; with direct charge alone the number is charged as typed. */}
        {(walletOtp || walletDirect) && (
          <div className="p-4 rounded-lg bg-primary/10 border border-border space-y-3">
            <div>
              <label className="text-sm font-semibold text-primary">Mobile Money number to pay from *</label>
              <Input
                type="tel"
                inputMode="numeric"
                placeholder="0241234567"
                value={paymentPhone}
                onChange={(e) => {
                  setPaymentPhone(e.target.value)
                  if (otpSent || otpVerified) { setOtpSent(false); setOtpVerified(false); setOtpCode(""); otpCooldown.reset() }
                }}
                disabled={(walletOtp && otpVerified) || isLoading}
                className="mt-1 bg-card font-mono"
              />
              <p className="text-xs text-primary mt-1">
                {walletOtp ? "The payment prompt is sent to this number. You verify it once." : "The payment prompt is sent to this number."}
              </p>
            </div>
            {walletOtp && (!otpVerified ? (
              !otpSent ? (
                <Button type="button" onClick={handleSendOtp} disabled={sendingOtp || otpCooldown.seconds > 0} className="w-full bg-primary hover:bg-primary text-white">
                  {sendingOtp ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending code…</>) : otpCooldown.seconds > 0 ? `Resend in ${otpCooldown.seconds}s` : "Send verification code"}
                </Button>
              ) : (
                <div className="space-y-2">
                  <Input inputMode="numeric" maxLength={6} placeholder="Enter 6-digit code" value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    className="text-center text-lg tracking-[0.4em] font-mono bg-card" />
                  <div className="flex gap-2">
                    <Button type="button" onClick={handleVerifyOtp} disabled={verifyingOtp || otpCode.length < 4} className="flex-1 bg-primary hover:bg-primary text-white">
                      {verifyingOtp ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying…</>) : "Verify"}
                    </Button>
                    <Button type="button" variant="outline" onClick={handleSendOtp} disabled={sendingOtp || otpCooldown.seconds > 0}>{otpCooldown.seconds > 0 ? `Resend in ${otpCooldown.seconds}s` : "Resend"}</Button>
                  </div>
                  <p className="text-xs text-muted-foreground">📩 Don&apos;t see the code? Check your phone&apos;s Spam or Blocked messages folder.</p>
                </div>
              )
            ) : (
              <div className="p-3 rounded-lg bg-success/10 border border-border flex items-center gap-2">
                <CheckCircle className="w-5 h-5 text-success" />
                <span className="text-sm font-medium text-success">Payment number verified ✓</span>
              </div>
            ))}
          </div>
        )}

        {/* Top Up Button */}
        <Button
          onClick={handleTopUp}
          disabled={isLoading || !amount || (walletOtp && !otpVerified) || (walletDirect && !walletOtp && !/^0?\d{9}$/.test(paymentPhone.replace(/\D/g, "")))}
          className="w-full bg-gradient-to-r from-primary to-primary/80 hover:from-primary hover:to-primary/80 text-white font-semibold py-6 text-lg"
        >
          {isLoading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Preparing Payment...
            </>
          ) : (
            <>
              <Zap className="h-4 w-4 mr-2" />
              Pay GHS {(parseFloat(amount || "0") * (1 + paystackFeePercentage / 100)).toFixed(2)}
            </>
          )}
        </Button>

        {/* Security Notice */}
        <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg">
          <p className="text-xs text-primary">
            <strong>🔒 Secure:</strong> Your payment is processed securely by Paystack. We never
            store your card details.
          </p>
        </div>
      </CardContent>
    </Card>

    {/* Live Mobile Money prompt sheet (direct-charge flow) -- the same
        persistent bottom sheet the storefront checkout uses, shared via
        components/shop/PaymentSheet.tsx. No --shop-accent ancestor exists
        on the dashboard, so accentColor is passed explicitly. */}
    {momoModal && (
      <PaymentSheet
        modal={momoModal}
        accentColor="#1b388b"
        onCancelSending={() => { paymentDismissedRef.current = true; setMomoModal(null); setPaymentStatus("idle") }}
        onDismiss={() => {
          paymentDismissedRef.current = true
          setMomoModal(null); setAmount(""); setPaymentPhone("")
          setOtpSent(false); setOtpVerified(false); setOtpCode(""); setPaymentStatus("idle")
          setMomoOtpInput(""); setMomoOtpSubmitting(false)
        }}
        onRetry={() => { setMomoModal(null); setPaymentStatus("idle"); setMomoOtpInput(""); setMomoOtpSubmitting(false) }}
        otpInput={momoOtpInput}
        setOtpInput={setMomoOtpInput}
        onSubmitOtp={submitMomoOtp}
        otpSubmitting={momoOtpSubmitting}
        renderSuccess={(modal) => (
          <div className="px-5 pb-6 pt-2 text-center space-y-4">
            <div className="mx-auto w-16 h-16 rounded-full bg-success/15 flex items-center justify-center">
              <CheckCircle className="w-9 h-9 text-success" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-foreground">Wallet topped up 🎉</h3>
              <p className="text-sm text-muted-foreground mt-1">Your wallet has been credited with GHS {Number(modal.summary?.amount || 0).toFixed(2)}.</p>
            </div>
            <Button
              onClick={() => {
                setMomoModal(null); setAmount(""); setPaymentPhone("")
                setOtpSent(false); setOtpVerified(false); setOtpCode(""); setPaymentStatus("idle")
                setMomoOtpInput(""); setMomoOtpSubmitting(false)
              }}
              className="w-full rounded-2xl bg-[#1b388b] hover:bg-[#1b388b]/90 text-white"
            >
              Done
            </Button>
          </div>
        )}
      />
    )}
    </div>
  )
}
