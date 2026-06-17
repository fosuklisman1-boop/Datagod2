"use client"

import { useEffect, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { shopOrderService } from "@/lib/shop-service"
import { useShopBasePath } from "@/lib/shop-url"
import { CheckCircle, Copy, ArrowRight, MessageCircle } from "lucide-react"
import Link from "next/link"
import { toast } from "sonner"

export default function OrderConfirmation() {
  const params = useParams()
  const router = useRouter()
  const shopSlug = params.slug as string
  const shopHome = useShopBasePath(shopSlug) || "/"
  const orderId = params.orderId as string

  const [order, setOrder] = useState<any>(null)
  const [shopName, setShopName] = useState<string | null>(null)
  const [shopWhatsapp, setShopWhatsapp] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadOrder()
  }, [orderId])

  const loadOrder = async () => {
    try {
      setLoading(true)
      const result = await shopOrderService.getOrderById(orderId)
      setOrder(result.order)
      setShopName(result.shopName ?? null)
      setShopWhatsapp(result.shopWhatsapp ?? null)
    } catch (error) {
      console.error("Error loading order:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to load order details"
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    toast.success("Copied to clipboard")
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-card flex items-center justify-center p-4">
        <p className="text-muted-foreground">Loading order details...</p>
      </div>
    )
  }

  if (!order) {
    return (
      <div className="min-h-screen bg-card p-4">
        <div className="max-w-2xl mx-auto pt-20">
          <Alert className="border-border bg-destructive/10">
            <AlertDescription className="text-destructive">
              Order not found. Please check your email for order confirmation.
            </AlertDescription>
          </Alert>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-card p-4">
      <div className="max-w-2xl mx-auto pt-8">
        {/* Success Message */}
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <div className="bg-success rounded-full p-3">
              <CheckCircle className="w-12 h-12 text-white" />
            </div>
          </div>
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold text-foreground mb-2">Order Placed Successfully!</h1>
          <p className="text-muted-foreground">
            Your order has been received and is being processed.
          </p>
        </div>

        {/* Order Details */}
        <Card className="mb-6 bg-card border-2 border-border">
          <CardHeader>
            <CardTitle>Order Confirmation</CardTitle>
            <CardDescription>Reference: {order.reference_code}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Order Info */}
            <div className="grid grid-cols-2 gap-4">
              <div className="p-3 bg-card/50 rounded-lg">
                <p className="text-xs text-muted-foreground">Order Number</p>
                <div className="flex items-center gap-2 mt-1">
                  <p className="font-mono font-semibold text-sm">{order.reference_code}</p>
                  <button
                    onClick={() => copyToClipboard(order.reference_code)}
                    title="Copy reference code"
                    className="hover:bg-muted p-1 rounded"
                  >
                    <Copy className="w-4 h-4 text-muted-foreground" />
                  </button>
                </div>
              </div>
              <div className="p-3 bg-card/50 rounded-lg">
                <p className="text-xs text-muted-foreground">Order Status</p>
                <Badge className="mt-1 bg-warning/15 text-warning">
                  {order.order_status}
                </Badge>
              </div>
              <div className="p-3 bg-card/50 rounded-lg">
                <p className="text-xs text-muted-foreground">Payment Status</p>
                <Badge className={`mt-1 ${
                  order.payment_status === "completed"
                    ? "bg-success/15 text-success"
                    : "bg-warning/15 text-warning"
                }`}>
                  {order.payment_status}
                </Badge>
              </div>
              <div className="p-3 bg-card/50 rounded-lg">
                <p className="text-xs text-muted-foreground">Order Date</p>
                <p className="font-semibold text-sm mt-1">
                  {new Date(order.created_at).toLocaleDateString()}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {new Date(order.created_at).toLocaleTimeString()}
                </p>
              </div>
            </div>

            {/* Package Details */}
            <div className="border-t border-border pt-4">
              <h3 className="font-semibold mb-3">Package Details</h3>
              <div className="space-y-2 p-3 bg-card/50 rounded-lg">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Network:</span>
                  <span className="font-semibold">{order.network}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Volume:</span>
                  <span className="font-semibold">{order.volume_gb}GB</span>
                </div>
              </div>
            </div>

            {/* Customer Info */}
            <div className="border-t border-border pt-4">
              <h3 className="font-semibold mb-3">Delivery Information</h3>
              <div className="space-y-2 p-3 bg-card/50 rounded-lg text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Customer Name</p>
                  <p className="font-semibold">{order.customer_name}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Phone Number</p>
                  <p className="font-semibold font-mono">{order.customer_phone}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Email</p>
                  <p className="font-semibold">{order.customer_email}</p>
                </div>
              </div>
            </div>

            {/* Next Steps */}
            <Alert className="border-border bg-primary/5">
              <AlertDescription className="text-primary text-sm">
                <strong>Next Steps:</strong>
                <ul className="list-disc list-inside mt-2 space-y-1">
                  <li>Your order is being processed</li>
                  <li>You will receive the data within 30 minutes</li>
                  <li>Check your email for updates</li>
                </ul>
              </AlertDescription>
            </Alert>

            {/* Action Buttons */}
            <div className="flex gap-3 pt-4">
              <Link href={shopHome} className="flex-1">
                <Button variant="outline" className="w-full">
                  Continue Shopping
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>

        {/* Support */}
        <Card className="bg-card border border-primary/20">
          <CardHeader>
            <CardTitle className="text-base">Need Help?</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p>If you encounter any issues with your order, contact <strong>{shopName ?? "the shop"}</strong>:</p>
            {shopWhatsapp ? (
              <a
                href={shopWhatsapp.startsWith("http") ? shopWhatsapp : `https://wa.me/${shopWhatsapp.replace(/\D/g, "")}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-2 font-semibold text-success hover:text-success/80"
              >
                <MessageCircle className="w-4 h-4" />
                Chat on WhatsApp
              </a>
            ) : (
              <p className="mt-2 text-muted-foreground text-xs">Contact details not set by shop owner.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
