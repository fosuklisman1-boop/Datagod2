"use client"

import { useEffect, useState } from "react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, XCircle, Clock, ChevronRight, Store, Loader2 } from "lucide-react"
import { shopService } from "@/lib/shop-service"
import { toast } from "sonner"

export default function AirtimeConfirmationPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const shopSlug = params.slug as string
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
      // Call verify endpoint
      const res = await fetch("/api/payments/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference })
      })
      
      // Load order details from DB (using public API or similar)
      const { data: orderData, error } = await fetch(`/api/shop/orders/status?orderId=${orderId}&type=airtime`).then(r => r.json())
      
      if (orderData) {
        setOrder(orderData)
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
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center space-y-4">
          <Loader2 className="w-10 h-10 animate-spin text-violet-600 mx-auto" />
          <p className="text-gray-600 font-medium">Verifying your payment...</p>
        </div>
      </div>
    )
  }

  const isSuccess = order?.payment_status === "completed" || order?.status === "pending" || order?.status === "completed"

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4 pb-20">
      <div className="w-full max-w-md space-y-6">
        {/* Shop Branding */}
        <div className="flex flex-col items-center space-y-2 mb-4">
          {shop?.logo_url ? (
            <img src={shop.logo_url} className="w-16 h-16 rounded-xl shadow-md object-cover" alt="Logo" />
          ) : (
            <Store className="w-12 h-12 text-violet-600" />
          )}
          <h2 className="text-xl font-bold">{shop?.shop_name || "Store"}</h2>
        </div>

        <Card className="border-0 shadow-xl overflow-hidden">
          <CardHeader className={`${isSuccess ? 'bg-green-600' : 'bg-red-600'} text-white text-center py-8`}>
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
                <span className="text-gray-500 font-medium">Reference Code</span>
                <span className="font-mono font-bold">{order?.reference_code || reference}</span>
              </div>
              <div className="flex justify-between items-center text-sm border-b pb-2">
                <span className="text-gray-500 font-medium">Amount Paid</span>
                <span className="font-bold">GHS {order?.total_paid?.toFixed(2) || "0.00"}</span>
              </div>
              <div className="flex justify-between items-center text-sm border-b pb-2">
                <span className="text-gray-500 font-medium">Recipient Gets</span>
                <span className="font-bold text-green-600">GHS {order?.airtime_amount?.toFixed(2) || "0.00"}</span>
              </div>
              <div className="flex justify-between items-center text-sm border-b pb-2">
                <span className="text-gray-500 font-medium">Recipient Number</span>
                <span className="font-bold">{order?.beneficiary_phone}</span>
              </div>
              <div className="flex justify-between items-center text-sm">
                <span className="text-gray-500 font-medium">Order Status</span>
                <Badge className={isSuccess ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}>
                  {order?.status?.toUpperCase() || "PENDING"}
                </Badge>
              </div>
            </div>

            <div className="bg-blue-50 p-4 rounded-lg flex gap-3">
              <Clock className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-blue-700 leading-relaxed">
                Airtime is usually delivered within 1-5 minutes. If you experience any delay, please contact the shop owner.
              </p>
            </div>

            <Button 
              onClick={() => router.push(`/shop/${shopSlug}`)}
              className="w-full bg-slate-900 hover:bg-slate-800 text-white"
            >
              Back to Store
              <ChevronRight className="w-4 h-4 ml-2" />
            </Button>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-gray-400">
          Powered by DATAGOD • Secure Transaction
        </p>
      </div>
    </div>
  )
}
