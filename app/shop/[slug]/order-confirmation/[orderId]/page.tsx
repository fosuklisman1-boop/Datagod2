"use client"

import { useEffect, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { shopOrderService } from "@/lib/shop-service"
import { CheckCircle, Copy, ArrowRight, Loader2 } from "lucide-react"
import Link from "next/link"
import { toast } from "sonner"
import { openPaystackModal } from "@/lib/payment-service"

// Add Paystack types to window
declare global {
  interface Window {
    PaystackPop: any
  }
}

export default function OrderConfirmation() {
  const params = useParams()
  const router = useRouter()
  const shopSlug = params.slug as string
  const orderId = params.orderId as string

  const [order, setOrder] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [isProcessingPayment, setIsProcessingPayment] = useState(false)

  useEffect(() => {
    loadOrder()
  }, [orderId])

  const loadOrder = async () => {
    try {
      setLoading(true)
      const orderData = await shopOrderService.getOrderById(orderId)
      setOrder(orderData)
    } catch (error) {
      console.error("Error loading order:", error)
      toast.error("Failed to load order details")
    } finally {
      setLoading(false)
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    toast.success("Copied to clipboard")
  }

  const handlePayment = async () => {
    if (!order) return

    setIsProcessingPayment(true)
    try {
      console.log("[ORDER-PAYMENT] Initializing payment for order:", orderId)

      // Initialize payment
      const response = await fetch("/api/payments/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: order.total_price,
          email: order.customer_email,
          userId: order.id, // Using order ID as user identifier for shop orders
          shopId: order.shop_id,
          orderId: order.id,
          shopSlug: shopSlug,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || "Failed to initialize payment")
      }

      const paymentData = await response.json()
      console.log("[ORDER-PAYMENT] Payment initialized:", paymentData)

      // Get Paystack public key from environment
      const paystackKey = process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY

      if (!paystackKey) {
        throw new Error("Paystack public key not configured")
      }

      // Open Paystack inline modal
      console.log("[ORDER-PAYMENT] Opening Paystack inline modal")
      const result = await openPaystackModal({
        key: paystackKey,
        email: order.customer_email,
        amount: order.total_price,
        reference: paymentData.reference,
        channels: ["card", "mobile_money", "bank_transfer"],
        metadata: {
          orderId: order.id,
          shopId: order.shop_id,
          shopSlug: shopSlug,
          customerName: order.customer_name,
          customerPhone: order.customer_phone,
        },
        onSuccess: async (reference) => {
          console.log("[ORDER-PAYMENT] Payment successful:", reference)
          toast.success("Payment successful! Redirecting...")
          
          // Verify payment
          try {
            const verifyResponse = await fetch("/api/payments/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ reference }),
            })

            if (verifyResponse.ok) {
              // Redirect to order status page
              router.push(`/shop/${shopSlug}/order-status/${orderId}?payment=success`)
            } else {
              console.warn("[ORDER-PAYMENT] Verification failed, redirecting anyway")
              router.push(`/shop/${shopSlug}/order-status/${orderId}`)
            }
          } catch (error) {
            console.error("[ORDER-PAYMENT] Verification error:", error)
            router.push(`/shop/${shopSlug}/order-status/${orderId}`)
          }
        },
        onClose: () => {
          console.log("[ORDER-PAYMENT] Payment modal closed")
          setIsProcessingPayment(false)
        },
      })

      if (!result) {
        console.log("[ORDER-PAYMENT] Payment cancelled by user")
        toast.info("Payment cancelled")
      }
    } catch (error) {
      console.error("[ORDER-PAYMENT] Error:", error)
      toast.error(error instanceof Error ? error.message : "Failed to process payment")
      setIsProcessingPayment(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex items-center justify-center p-4">
        <p className="text-gray-600">Loading order details...</p>
      </div>
    )
  }

  if (!order) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-4">
        <div className="max-w-2xl mx-auto pt-20">
          <Alert className="border-red-300 bg-red-50">
            <AlertDescription className="text-red-700">
              Order not found. Please check your email for order confirmation.
            </AlertDescription>
          </Alert>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-4">
      <div className="max-w-2xl mx-auto pt-8">
        {/* Success Message */}
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <div className="bg-gradient-to-br from-green-400 to-emerald-500 rounded-full p-3">
              <CheckCircle className="w-12 h-12 text-white" />
            </div>
          </div>
          <h1 className="text-4xl font-bold text-gray-900 mb-2">Order Placed Successfully!</h1>
          <p className="text-gray-600">
            Your order has been received. Check your email for updates and payment instructions.
          </p>
        </div>

        {/* Order Details */}
        <Card className="mb-6 bg-gradient-to-br from-green-50/60 to-emerald-50/40 border-2 border-green-200/40">
          <CardHeader>
            <CardTitle>Order Confirmation</CardTitle>
            <CardDescription>Reference: {order.reference_code}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Order Info */}
            <div className="grid grid-cols-2 gap-4">
              <div className="p-3 bg-white/50 rounded-lg">
                <p className="text-xs text-gray-600">Order Number</p>
                <div className="flex items-center gap-2 mt-1">
                  <p className="font-mono font-semibold text-sm">{order.reference_code}</p>
                  <button
                    onClick={() => copyToClipboard(order.reference_code)}
                    title="Copy reference code"
                    className="hover:bg-gray-200 p-1 rounded"
                  >
                    <Copy className="w-4 h-4 text-gray-600" />
                  </button>
                </div>
              </div>
              <div className="p-3 bg-white/50 rounded-lg">
                <p className="text-xs text-gray-600">Order Status</p>
                <Badge className="mt-1 bg-amber-100 text-amber-700">
                  {order.order_status}
                </Badge>
              </div>
              <div className="p-3 bg-white/50 rounded-lg">
                <p className="text-xs text-gray-600">Payment Status</p>
                <Badge className={`mt-1 ${
                  order.payment_status === "completed"
                    ? "bg-green-100 text-green-700"
                    : "bg-amber-100 text-amber-700"
                }`}>
                  {order.payment_status}
                </Badge>
              </div>
              <div className="p-3 bg-white/50 rounded-lg">
                <p className="text-xs text-gray-600">Order Date</p>
                <p className="font-semibold text-sm mt-1">
                  {new Date(order.created_at).toLocaleDateString()}
                </p>
              </div>
            </div>

            {/* Package Details */}
            <div className="border-t border-white/20 pt-4">
              <h3 className="font-semibold mb-3">Package Details</h3>
              <div className="space-y-2 p-3 bg-white/50 rounded-lg">
                <div className="flex justify-between">
                  <span className="text-gray-600">Network:</span>
                  <span className="font-semibold">{order.network}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Volume:</span>
                  <span className="font-semibold">{order.volume_gb}GB</span>
                </div>
              </div>
            </div>

            {/* Pricing Breakdown */}
            <div className="border-t border-white/20 pt-4">
              <h3 className="font-semibold mb-3">Pricing Breakdown</h3>
              <div className="space-y-2 p-3 bg-white/50 rounded-lg">
                <div className="flex justify-between">
                  <span className="text-gray-600">Base Price:</span>
                  <span>GHS {order.base_price.toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Service Fee:</span>
                  <span>GHS {order.profit_amount.toFixed(2)}</span>
                </div>
                <div className="flex justify-between border-t border-white/20 pt-2 font-bold text-lg">
                  <span>Total Amount:</span>
                  <span className="bg-gradient-to-r from-green-600 to-emerald-600 bg-clip-text text-transparent">
                    GHS {order.total_price.toFixed(2)}
                  </span>
                </div>
              </div>
            </div>

            {/* Customer Info */}
            <div className="border-t border-white/20 pt-4">
              <h3 className="font-semibold mb-3">Delivery Information</h3>
              <div className="space-y-2 p-3 bg-white/50 rounded-lg text-sm">
                <div>
                  <p className="text-xs text-gray-600">Customer Name</p>
                  <p className="font-semibold">{order.customer_name}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-600">Phone Number</p>
                  <p className="font-semibold font-mono">{order.customer_phone}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-600">Email</p>
                  <p className="font-semibold">{order.customer_email}</p>
                </div>
              </div>
            </div>

            {/* Next Steps */}
            <Alert className="border-blue-300 bg-blue-50">
              <AlertDescription className="text-blue-700 text-sm">
                <strong>Next Steps:</strong>
                <ul className="list-disc list-inside mt-2 space-y-1">
                  <li>Complete payment to process your order</li>
                  <li>You will receive the data within 30 minutes of payment</li>
                  <li>Check your email for payment instructions</li>
                </ul>
              </AlertDescription>
            </Alert>

            {/* Action Buttons */}
            <div className="flex gap-3 pt-4">
              <Link href={`/shop/${shopSlug}`} className="flex-1">
                <Button variant="outline" className="w-full" disabled={isProcessingPayment}>
                  Continue Shopping
                </Button>
              </Link>
              <Button 
                className="flex-1 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700"
                onClick={handlePayment}
                disabled={isProcessingPayment || order.payment_status === "completed"}
              >
                {isProcessingPayment ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Processing...
                  </>
                ) : order.payment_status === "completed" ? (
                  "Payment Completed"
                ) : (
                  <>
                    Proceed to Payment
                    <ArrowRight className="w-4 h-4 ml-2" />
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Support */}
        <Card className="bg-gradient-to-br from-blue-50/60 to-cyan-50/40 border border-blue-200/40">
          <CardHeader>
            <CardTitle className="text-base">Need Help?</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-gray-600">
            <p>If you encounter any issues with your order, please contact our support team:</p>
            <p className="mt-2 font-semibold">Email: support@datagod.com</p>
            <p>WhatsApp: +233 XXX XXX XXXX</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
