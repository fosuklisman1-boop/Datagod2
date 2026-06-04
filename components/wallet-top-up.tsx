"use client"

import { useState, useEffect } from "react"
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
  const [momoModal, setMomoModal] = useState<null | { state: "awaiting" | "success" | "failed"; reference?: string; summary?: any; message?: string }>(null)

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
        const summary = { amount: parseFloat(amount), paymentPhone, reference: data.reference }
        setMomoModal({ state: "awaiting", reference: data.reference, summary })
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
      setPaymentStatus("error")
      setErrorMessage(error instanceof Error ? error.message : "Payment initialization failed")
      toast.error("Payment initialization failed")
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
      <Card className="w-full border-l-4 border-l-cyan-500 bg-gradient-to-br from-cyan-50/60 to-primary/5 backdrop-blur-xl border border-cyan-200/40 hover:border-cyan-300/60">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-cyan-600" />
          Wallet Top Up
        </CardTitle>
        <CardDescription>Add funds to your wallet using Paystack</CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Error Alert */}
        {paymentStatus === "error" && errorMessage && (
          <Alert className="bg-red-50 border-red-200">
            <AlertCircle className="h-4 w-4 text-red-600" />
            <AlertDescription className="text-red-800">{errorMessage}</AlertDescription>
          </Alert>
        )}

        {/* Success Alert */}
        {paymentStatus === "success" && (
          <Alert className="bg-green-50 border-green-200">
            <CheckCircle className="h-4 w-4 text-green-600" />
            <AlertDescription className="text-green-800">
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
                className="text-sm font-semibold hover:bg-cyan-100 hover:border-cyan-400"
              >
                GHS {quickAmount}
              </Button>
            ))}
          </div>
        </div>

        {/* Email Display */}
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">Email</p>
          <div className="flex items-center gap-2 p-3 bg-card/40 backdrop-blur border border-cyan-200/40 rounded-lg">
            <span className="text-sm text-muted-foreground">{email || "Loading..."}</span>
          </div>
        </div>

        {/* Fee Breakdown */}
        {amount && parseFloat(amount) > 0 && (
          <div className="p-4 bg-gradient-to-br from-orange-50 to-amber-50 border border-orange-200/50 rounded-lg space-y-2">
            <p className="text-sm font-medium text-foreground">Payment Summary</p>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>Wallet Top Up:</span>
                <span>GHS {parseFloat(amount || "0").toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-orange-600">
                <span>Paystack Fee ({paystackFeePercentage}%):</span>
                <span>GHS {(parseFloat(amount || "0") * paystackFeePercentage / 100).toFixed(2)}</span>
              </div>
              <div className="pt-1 border-t border-orange-200 flex justify-between font-semibold text-foreground">
                <span>Total Amount:</span>
                <span>GHS {(parseFloat(amount || "0") * (1 + paystackFeePercentage / 100)).toFixed(2)}</span>
              </div>
            </div>
            <p className="text-xs text-orange-700 mt-2">The {paystackFeePercentage}% fee is charged by Paystack for payment processing.</p>
          </div>
        )}

        {/* Payment Status Badge */}
        {paymentStatus !== "idle" && (
          <div className="flex items-center gap-2">
            <Badge
              className={
                paymentStatus === "success"
                  ? "bg-green-100 text-green-800"
                  : paymentStatus === "error"
                    ? "bg-red-100 text-red-800"
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
          <div className="p-4 rounded-lg bg-purple-50 border border-purple-200 space-y-3">
            <div>
              <label className="text-sm font-semibold text-purple-900">Mobile Money number to pay from *</label>
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
              <p className="text-xs text-purple-700 mt-1">
                {walletOtp ? "The payment prompt is sent to this number. You verify it once." : "The payment prompt is sent to this number."}
              </p>
            </div>
            {walletOtp && (!otpVerified ? (
              !otpSent ? (
                <Button type="button" onClick={handleSendOtp} disabled={sendingOtp || otpCooldown.seconds > 0} className="w-full bg-purple-600 hover:bg-purple-700 text-white">
                  {sendingOtp ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending code…</>) : otpCooldown.seconds > 0 ? `Resend in ${otpCooldown.seconds}s` : "Send verification code"}
                </Button>
              ) : (
                <div className="space-y-2">
                  <Input inputMode="numeric" maxLength={6} placeholder="Enter 6-digit code" value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    className="text-center text-lg tracking-[0.4em] font-mono bg-card" />
                  <div className="flex gap-2">
                    <Button type="button" onClick={handleVerifyOtp} disabled={verifyingOtp || otpCode.length < 4} className="flex-1 bg-purple-600 hover:bg-purple-700 text-white">
                      {verifyingOtp ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying…</>) : "Verify"}
                    </Button>
                    <Button type="button" variant="outline" onClick={handleSendOtp} disabled={sendingOtp || otpCooldown.seconds > 0}>{otpCooldown.seconds > 0 ? `Resend in ${otpCooldown.seconds}s` : "Resend"}</Button>
                  </div>
                  <p className="text-xs text-muted-foreground">📩 Don&apos;t see the code? Check your phone&apos;s Spam or Blocked messages folder.</p>
                </div>
              )
            ) : (
              <div className="p-3 rounded-lg bg-green-50 border border-green-200 flex items-center gap-2">
                <CheckCircle className="w-5 h-5 text-green-600" />
                <span className="text-sm font-medium text-green-900">Payment number verified ✓</span>
              </div>
            ))}
          </div>
        )}

        {/* Top Up Button */}
        <Button
          onClick={handleTopUp}
          disabled={isLoading || !amount || (walletOtp && !otpVerified) || (walletDirect && !walletOtp && !/^0?\d{9}$/.test(paymentPhone.replace(/\D/g, "")))}
          className="w-full bg-gradient-to-r from-cyan-600 to-primary/80 hover:from-cyan-700 hover:to-primary/80 text-white font-semibold py-6 text-lg"
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

    {/* Live Mobile Money prompt modal (direct-charge flow) */}
    {momoModal && (
      <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-[60]">
        <Card className="w-full max-w-md bg-card rounded-2xl">
          {momoModal.state === "awaiting" && (
            <CardContent className="pt-8 pb-6 text-center space-y-4">
              <div className="mx-auto w-16 h-16 rounded-full bg-purple-100 flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-purple-600 animate-spin" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-foreground">Approve the prompt on your phone</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  We sent a Mobile Money prompt to{" "}
                  <span className="font-semibold">{momoModal.summary?.paymentPhone}</span>. Enter your PIN to approve the top-up of{" "}
                  <span className="font-semibold">GHS {Number(momoModal.summary?.amount || 0).toFixed(2)}</span>.
                </p>
              </div>
              <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="w-3 h-3 animate-spin" /> Waiting for confirmation…
              </div>
              <p className="text-xs text-muted-foreground">Keep this page open. This can take up to a minute.</p>
            </CardContent>
          )}

          {momoModal.state === "success" && (
            <CardContent className="pt-8 pb-6 text-center space-y-4">
              <div className="mx-auto w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
                <CheckCircle className="w-9 h-9 text-green-600" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-foreground">Wallet topped up 🎉</h3>
                <p className="text-sm text-muted-foreground mt-1">Your wallet has been credited with GHS {Number(momoModal.summary?.amount || 0).toFixed(2)}.</p>
              </div>
              <Button
                onClick={() => {
                  setMomoModal(null); setAmount(""); setPaymentPhone("")
                  setOtpSent(false); setOtpVerified(false); setOtpCode(""); setPaymentStatus("idle")
                }}
                className="w-full bg-gradient-to-r from-cyan-600 to-primary/80 hover:from-cyan-700 hover:to-primary/80 text-white"
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
                <h3 className="text-lg font-bold text-foreground">Top-up not completed</h3>
                <p className="text-sm text-muted-foreground mt-1">{momoModal.message || "The prompt was not approved. Please try again."}</p>
              </div>
              <Button variant="outline" onClick={() => { setMomoModal(null); setPaymentStatus("idle") }} className="w-full">Close</Button>
            </CardContent>
          )}
        </Card>
      </div>
    )}
    </div>
  )
}
