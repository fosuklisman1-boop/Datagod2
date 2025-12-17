"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Loader2, AlertCircle, CheckCircle, Zap } from "lucide-react"
import { initializePayment } from "@/lib/payment-service"
import { PaystackInlineModal } from "@/components/paystack-inline-modal"
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
  const [paystackFeePercentage, setPaystackFeePercentage] = useState(3.0)
  const [showPaymentModal, setShowPaymentModal] = useState(false)
  const [paymentReference, setPaymentReference] = useState<string | null>(null)

  // Predefined amounts
  const quickAmounts = [50, 100, 200, 500]

  useEffect(() => {
    fetchUserInfo()
    fetchFeeSettings()
  }, [])

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

      // Store reference and show inline modal
      setPaymentReference(paymentResult.reference)
      setShowPaymentModal(true)
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
    setShowPaymentModal(false)
    
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
            min="5"
            step="0.01"
            disabled={isLoading}
            className="text-lg"
          />
          <p className="text-xs text-gray-500">Minimum: GHS 5.00</p>
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
                <span>Paystack Fee ({paystackFeePercentage}%):</span>
                <span>GHS {(parseFloat(amount || "0") * paystackFeePercentage / 100).toFixed(2)}</span>
              </div>
              <div className="pt-1 border-t border-orange-200 flex justify-between font-semibold text-gray-900">
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
          disabled={isLoading || !amount}
          className="w-full bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-700 hover:to-blue-700 text-white font-semibold py-6 text-lg"
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
        <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
          <p className="text-xs text-blue-800">
            <strong>🔒 Secure:</strong> Your payment is processed securely by Paystack. We never
            store your card details.
          </p>
        </div>
      </CardContent>
    </Card>

    {/* Paystack Inline Payment Modal */}
    {paymentReference && (
      <PaystackInlineModal
        isOpen={showPaymentModal}
        onOpenChange={setShowPaymentModal}
        amount={parseFloat(amount)}
        email={email}
        reference={paymentReference}
        onSuccess={handlePaymentSuccess}
        onClose={() => {
          setShowPaymentModal(false)
          setPaymentStatus("idle")
        }}
        title="Complete Your Wallet Top-Up"
        description="Enter your payment details to add funds to your wallet"
      />
    )}
    </div>
  )
}
