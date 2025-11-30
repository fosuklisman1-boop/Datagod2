"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Loader2, AlertCircle, CheckCircle, Zap, Bug } from "lucide-react"
import { initializePayment } from "@/lib/payment-service"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"

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
  const paystackPublicKey = process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY || ""

  // Predefined amounts
  const quickAmounts = [50, 100, 200, 500]

  useEffect(() => {
    fetchUserInfo()
  }, [])

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

  const handleTopUp = async () => {
    // Validation
    if (!amount || parseFloat(amount) <= 0) {
      setErrorMessage("Please enter a valid amount")
      toast.error("Invalid amount")
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

    try {
      setIsLoading(true)
      setPaymentStatus("processing")
      setErrorMessage("")

      console.log("[WALLET-TOPUP] Starting payment with amount:", amount)

      // Initialize payment
      const paymentResult = await initializePayment({
        amount: parseFloat(amount),
        email,
        userId,
      })

      console.log("[WALLET-TOPUP] Payment initialized:", paymentResult)

      console.log("[WALLET-TOPUP] Redirecting to Paystack checkout URL:", paymentResult.authorizationUrl)
      
      // Store the payment reference in sessionStorage for verification after redirect
      sessionStorage.setItem('lastPaymentReference', paymentResult.reference)
      
      setPaymentStatus("processing")
      
      // Use direct redirect instead of popup (works better cross-browser, especially Safari)
      // Paystack will redirect back to our redirect URL after payment
      setTimeout(() => {
        window.location.href = paymentResult.authorizationUrl
      }, 500)
    } catch (error) {
      console.error("[WALLET-TOPUP] Error:", error)
      setPaymentStatus("error")
      setErrorMessage(error instanceof Error ? error.message : "Payment initialization failed")
      toast.error("Payment initialization failed")
      setIsLoading(false)
    }
  }

  return (
    <Card className="w-full border-l-4 border-l-cyan-500 bg-gradient-to-br from-cyan-50/60 to-blue-50/40 backdrop-blur-xl border border-cyan-200/40 hover:border-cyan-300/60">
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
          <label className="text-sm font-medium text-gray-700">Amount (GHS)</label>
          <Input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Enter amount"
            min="1"
            step="0.01"
            disabled={isLoading || isProcessing}
            className="text-lg"
          />
          <p className="text-xs text-gray-500">Minimum: GHS 1.00</p>
        </div>

        {/* Quick Amount Buttons */}
        <div className="space-y-2">
          <p className="text-sm font-medium text-gray-700">Quick amounts</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1 sm:gap-2">
            {quickAmounts.map((quickAmount) => (
              <Button
                key={quickAmount}
                variant="outline"
                onClick={() => handleQuickAmount(quickAmount)}
                disabled={isLoading || isProcessing}
                className="text-sm font-semibold hover:bg-cyan-100 hover:border-cyan-400"
              >
                GHS {quickAmount}
              </Button>
            ))}
          </div>
        </div>

        {/* Email Display */}
        <div className="space-y-2">
          <p className="text-sm font-medium text-gray-700">Email</p>
          <div className="flex items-center gap-2 p-3 bg-white/40 backdrop-blur border border-cyan-200/40 rounded-lg">
            <span className="text-sm text-gray-600">{email || "Loading..."}</span>
          </div>
        </div>

        {/* Fee Breakdown */}
        {amount && parseFloat(amount) > 0 && (
          <div className="p-4 bg-gradient-to-br from-orange-50 to-amber-50 border border-orange-200/50 rounded-lg space-y-2">
            <p className="text-sm font-medium text-gray-700">Payment Summary</p>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between text-gray-600">
                <span>Wallet Top Up:</span>
                <span>GHS {parseFloat(amount || "0").toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-orange-600">
                <span>Paystack Fee (3%):</span>
                <span>GHS {(parseFloat(amount || "0") * 0.03).toFixed(2)}</span>
              </div>
              <div className="pt-1 border-t border-orange-200 flex justify-between font-semibold text-gray-900">
                <span>Total Amount:</span>
                <span>GHS {(parseFloat(amount || "0") * 1.03).toFixed(2)}</span>
              </div>
            </div>
            <p className="text-xs text-orange-700 mt-2">The 3% fee is charged by Paystack for payment processing.</p>
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
                    : "bg-blue-100 text-blue-800"
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

        {/* Top Up Button */}
        <Button
          onClick={handleTopUp}
          disabled={isLoading || isProcessing || !amount}
          className="w-full bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-700 hover:to-blue-700 text-white font-semibold py-6 text-lg"
        >
          {isLoading || isProcessing ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Redirecting to Payment...
            </>
          ) : (
            <>
              <Zap className="h-4 w-4 mr-2" />
              Pay GHS {(parseFloat(amount || "0") * 1.03).toFixed(2)}
            </>
          )}
        </Button>

        {/* Debug Panel */}
        <div className="pt-4 border-t border-gray-200">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowDebug(!showDebug)}
            className="gap-2"
          >
            <Bug className="h-4 w-4" />
            {showDebug ? "Hide" : "Show"} Debug Info
          </Button>

          {showDebug && paymentStatus === "processing" && (
            <div className="mt-4 p-4 bg-slate-900 text-slate-50 rounded-lg font-mono text-xs space-y-2">
              <div>
                <span className="text-cyan-400">status:</span>{" "}
                <span className="text-slate-300">Redirecting to Paystack...</span>
              </div>
              <div>
                <span className="text-cyan-400">email:</span>{" "}
                <span className="text-slate-300">{email}</span>
              </div>
              <div>
                <span className="text-cyan-400">amount:</span>{" "}
                <span className="text-slate-300">{amount} GHS (total with 3% fee)</span>
              </div>
            </div>
          )}
        </div>

        {/* Security Notice */}
        <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
          <p className="text-xs text-blue-800">
            <strong>🔒 Secure:</strong> Your payment is processed securely by Paystack. We never
            store your card details.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
