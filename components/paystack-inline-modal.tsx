"use client"

import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2, CheckCircle2, AlertCircle, Copy } from "lucide-react"
import { toast } from "sonner"

interface PaystackInlineModalProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  amount: number // Amount in GHS
  email: string
  reference: string
  onSuccess?: (reference: string) => void
  onClose?: () => void
  title?: string
  description?: string
}

/**
 * Paystack Inline Payment Modal
 * Opens Paystack payment modal inline without redirecting user
 * 
 * Usage:
 * const [isOpen, setIsOpen] = useState(false)
 * <PaystackInlineModal
 *   isOpen={isOpen}
 *   onOpenChange={setIsOpen}
 *   amount={100}
 *   email="user@example.com"
 *   reference="REF-123456"
 *   onSuccess={(ref) => console.log("Payment successful:", ref)}
 * />
 */
export function PaystackInlineModal({
  isOpen,
  onOpenChange,
  amount,
  email,
  reference,
  onSuccess,
  onClose,
  title = "Complete Payment",
  description = "Use the Paystack modal to complete your payment securely",
}: PaystackInlineModalProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle")
  const paystackPublicKey = process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY || ""

  // Load Paystack script if not already loaded
  useEffect(() => {
    if (!window.PaystackPop && isOpen) {
      const script = document.createElement("script")
      script.src = "https://js.paystack.co/v1/inline.js"
      script.async = true
      script.onload = () => {
        console.log("[PAYSTACK-MODAL] Paystack script loaded")
      }
      script.onerror = () => {
        console.error("[PAYSTACK-MODAL] Failed to load Paystack script")
        setError("Failed to load payment provider")
        setStatus("error")
      }
      document.body.appendChild(script)
    }
  }, [isOpen])

  const handlePayment = async () => {
    try {
      setLoading(true)
      setError(null)
      setStatus("loading")

      // Ensure Paystack script is loaded
      if (!window.PaystackPop) {
        throw new Error("Payment provider not ready. Please try again.")
      }

      // Setup Paystack inline payment
      const handler = window.PaystackPop.setup({
        key: paystackPublicKey,
        email: email,
        amount: Math.round(amount * 100), // Convert GHS to kobo
        ref: reference,
        onClose: () => {
          console.log("[PAYSTACK-MODAL] Payment modal closed by user")
          setLoading(false)
          setStatus("idle")
          if (onClose) onClose()
        },
        onSuccess: (response: any) => {
          console.log("[PAYSTACK-MODAL] Payment successful:", response)
          setStatus("success")
          setLoading(false)
          
          // Show success message
          toast.success("Payment successful! Verifying with Paystack...")
          
          // Call success callback
          if (onSuccess) {
            onSuccess(response.reference)
          }

          // Close modal after 2 seconds
          setTimeout(() => {
            onOpenChange(false)
            setStatus("idle")
          }, 2000)
        },
      })

      // Open the payment modal
      handler.openIframe()
    } catch (err) {
      console.error("[PAYSTACK-MODAL] Error:", err)
      const errorMessage = err instanceof Error ? err.message : "Failed to process payment"
      setError(errorMessage)
      setStatus("error")
      setLoading(false)
      toast.error(errorMessage)
    }
  }

  const handleCopyReference = () => {
    navigator.clipboard.writeText(reference)
    toast.success("Reference copied to clipboard")
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Payment Details */}
          <div className="space-y-3 p-4 bg-gray-50 rounded-lg">
            <div className="flex justify-between items-center">
              <span className="text-sm text-gray-600">Amount</span>
              <span className="font-semibold text-lg">GHS {amount.toFixed(2)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-gray-600">Email</span>
              <span className="font-mono text-xs truncate">{email}</span>
            </div>
            <div className="flex justify-between items-center gap-2">
              <span className="text-sm text-gray-600">Reference</span>
              <div className="flex items-center gap-1">
                <span className="font-mono text-xs bg-white px-2 py-1 rounded border truncate">
                  {reference}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleCopyReference}
                  className="h-6 w-6 p-0"
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
            </div>
          </div>

          {/* Status Messages */}
          {status === "idle" && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                Click "Pay Now" to open the Paystack payment modal securely.
              </AlertDescription>
            </Alert>
          )}

          {status === "loading" && (
            <Alert className="border-blue-200 bg-blue-50">
              <Loader2 className="h-4 w-4 animate-spin" />
              <AlertDescription className="text-blue-800">
                Opening payment modal...
              </AlertDescription>
            </Alert>
          )}

          {status === "success" && (
            <Alert className="border-green-200 bg-green-50">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <AlertDescription className="text-green-800">
                Payment successful! Your transaction is being processed.
              </AlertDescription>
            </Alert>
          )}

          {status === "error" && error && (
            <Alert className="border-red-200 bg-red-50">
              <AlertCircle className="h-4 w-4 text-red-600" />
              <AlertDescription className="text-red-800">{error}</AlertDescription>
            </Alert>
          )}

          {/* Action Buttons */}
          <div className="flex gap-2">
            {status !== "success" && (
              <Button
                onClick={handlePayment}
                disabled={loading}
                className="flex-1 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800"
              >
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {loading ? "Processing..." : "Pay Now"}
              </Button>
            )}

            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
              className="flex-1"
            >
              {status === "success" ? "Done" : "Cancel"}
            </Button>
          </div>

          {/* Info Text */}
          <p className="text-xs text-gray-500 text-center">
            Secure payment powered by Paystack. Your payment information is encrypted.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
