"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Loader2, AlertCircle, CheckCircle, Zap } from "lucide-react"
import { initializePayment, verifyPayment } from "@/lib/payment-service"
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
  const [isProcessing, setIsProcessing] = useState(false)
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

      // Initialize payment
      const paymentResult = await initializePayment({
        amount: parseFloat(amount),
        email,
        userId,
      })

      // Load Paystack script if not already loaded
      if (!window.PaystackPop) {
        await loadPaystackScript()
      }

      // Open Paystack modal
      const handler = window.PaystackPop!.setup({
        key: paystackPublicKey,
        email,
        amount: parseFloat(amount) * 100, // Already converted to smallest unit by backend, but Paystack expects kobo
        ref: paymentResult.reference,
        onClose: () => {
          setIsLoading(false)
          setPaymentStatus("idle")
          toast.info("Payment modal closed")
        },
        onSuccess: async () => {
          setIsProcessing(true)
          try {
            // Verify payment
            const verificationResult = await verifyPayment({
              reference: paymentResult.reference,
            })

            if (verificationResult.status === "success") {
              setPaymentStatus("success")
              toast.success(`Payment successful! GHS ${verificationResult.amount} added to wallet.`)
              setAmount("")
              if (onSuccess) {
                onSuccess(verificationResult.amount)
              }
            } else {
              setPaymentStatus("error")
              setErrorMessage(`Payment status: ${verificationResult.status}`)
              toast.error(`Payment ${verificationResult.status}`)
            }
          } catch (error) {
            setPaymentStatus("error")
            setErrorMessage(error instanceof Error ? error.message : "Verification failed")
            toast.error("Payment verification failed")
          } finally {
            setIsProcessing(false)
            setIsLoading(false)
          }
        },
      })

      handler.openIframe()
    } catch (error) {
      setPaymentStatus("error")
      setErrorMessage(error instanceof Error ? error.message : "Payment initialization failed")
      toast.error("Payment initialization failed")
      setIsLoading(false)
    }
  }

  const loadPaystackScript = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (document.getElementById("paystack-script")) {
        resolve()
        return
      }

      const script = document.createElement("script")
      script.id = "paystack-script"
      script.src = "https://js.paystack.co/v1/inline.js"
      script.onload = () => resolve()
      script.onerror = () => reject(new Error("Failed to load Paystack script"))
      document.body.appendChild(script)
    })
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
          <div className="grid grid-cols-4 gap-2">
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
              {isProcessing ? "Processing..." : "Initializing Payment..."}
            </>
          ) : (
            <>
              <Zap className="h-4 w-4 mr-2" />
              Top Up Wallet - GHS {parseFloat(amount || "0").toFixed(2)}
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
  )
}
