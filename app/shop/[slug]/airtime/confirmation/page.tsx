"use client"

import { useEffect, useState } from "react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, XCircle, Clock, ChevronRight, Store, Loader2 } from "lucide-react"
import { shopService } from "@/lib/shop-service"
import { useShopBasePath } from "@/lib/shop-url"
import { toast } from "sonner"

export default function AirtimeConfirmationPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const shopSlug = params.slug as string
  const shopHome = useShopBasePath(shopSlug) || "/"
  const reference = searchParams.get("reference")
  const orderId = searchParams.get("orderId")

  const [shop, setShop] = useState<any>(null)
  const [order, setOrder] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [verifying, setVerifying] = useState(true)

  useEffect(() => {
    if (shopSlug) loadShop()
    if (reference) verifyAndLoadOrder()
  }, [shopSlug, reference])

  const loadShop = async () => {
    try {
      const data = await shopService.getShopBySlug(shopSlug)
      setShop(data)
    } catch (e) {}
  }

  const verifyAndLoadOrder = async () => {
    try {
      setVerifying(true)

      // Step 1: Verify the payment first — this updates DB
      if (reference) {
        await fetch("/api/payments/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reference })
        })
      }

      // Step 2: Poll for updated order status (up to 4 retries, 1.5s apart)
      if (orderId) {
        let orderData = null
        for (let attempt = 0; attempt < 4; attempt++) {
          if (attempt > 0) await new Promise(r => setTimeout(r, 1500))

          const res = await fetch(`/api/shop/orders/status?orderId=${orderId}&type=airtime`)
          const json = await res.json()

          if (json.data) {
            orderData = json.data
            // If payment is confirmed, stop polling early
            if (orderData.payment_status === "completed" || orderData.status === "pending" || orderData.status === "completed") {
              break
            }
          }
        }

        if (orderData) {
          setOrder(orderData)
        }
      }
    } catch (error) {
      console.error("Verification error:", error)
    } finally {
      setVerifying(false)
      setLoading(false)
    }
  }

  if (loading || verifying) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/40">
        <div className="text-center space-y-4">
          <Loader2 className="w-10 h-10 animate-spin text-primary mx-auto" />
          <p className="text-muted-foreground font-medium">Verifying your payment...</p>
        </div>
      </div>
    )
  }

  const isSuccess = order?.payment_status === "completed" || order?.status === "pending" || order?.status === "completed"

  return (
    <div className="min-h-screen bg-muted/40 flex flex-col items-center justify-center p-4 pb-20">
      <div className="w-full max-w-md space-y-6">
        {/* Shop Branding */}
        <div className="flex flex-col items-center space-y-2 mb-4">
          {shop?.logo_url ? (
            <img src={shop.logo_url} className="w-16 h-16 rounded-xl shadow-md object-cover" alt="Logo" />
          ) : (
            <Store className="w-12 h-12 text-primary" />
          )}
          <h2 className="text-xl font-bold">{shop?.shop_name || "Store"}</h2>
        </div>

        <Card className="border-0 shadow-xl overflow-hidden">
          <CardHeader className={`${isSuccess ? 'bg-success' : 'bg-destructive'} text-white text-center py-8`}>
            {isSuccess ? (
              <CheckCircle2 className="w-16 h-16 mx-auto mb-4" />
            ) : (
              <XCircle className="w-16 h-16 mx-auto mb-4" />
            )}
            <CardTitle className="text-2xl">
              {isSuccess ? "Payment Received!" : "Payment Failed"}
            </CardTitle>
            <CardDescription className="text-white/80">
              {isSuccess 
                ? "Your airtime is being processed." 
                : "Something went wrong with your transaction."}
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6 space-y-6">
            <div className="space-y-4">
              <div className="flex justify-between items-center text-sm border-b pb-2">
                <span className="text-muted-foreground font-medium">Reference Code</span>
                <span className="font-mono font-bold">{order?.reference_code || reference}</span>
              </div>
              <div className="flex justify-between items-center text-sm border-b pb-2">
                <span className="text-muted-foreground font-medium">Amount Paid</span>
                <span className="font-bold">GHS {order?.total_paid?.toFixed(2) || "0.00"}</span>
              </div>
              <div className="flex justify-between items-center text-sm border-b pb-2">
                <span className="text-muted-foreground font-medium">Recipient Gets</span>
                <span className="font-bold text-success">GHS {order?.airtime_amount?.toFixed(2) || "0.00"}</span>
              </div>
              <div className="flex justify-between items-center text-sm border-b pb-2">
                <span className="text-muted-foreground font-medium">Recipient Number</span>
                <span className="font-bold">{order?.beneficiary_phone}</span>
              </div>
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground font-medium">Order Status</span>
                <Badge className={isSuccess ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"}>
                  {order?.status?.toUpperCase() || "PENDING"}
                </Badge>
              </div>
            </div>

            <div className="bg-primary/5 p-4 rounded-lg flex gap-3">
              <Clock className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
              <p className="text-xs text-primary leading-relaxed">
                Airtime is usually delivered within 1-5 minutes. If you experience any delay, please contact the shop owner.
              </p>
            </div>

            <Button 
              onClick={() => router.push(shopHome)}
              className="w-full bg-foreground hover:bg-foreground/90 text-background"
            >
              Back to Store
              <ChevronRight className="w-4 h-4 ml-2" />
            </Button>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground">
          Powered by DATAGOD • Secure Transaction
        </p>
      </div>
    </div>
  )
}
