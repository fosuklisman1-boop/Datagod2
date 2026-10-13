"use client"

import { useEffect, useState } from "react"
import { useParams, useSearchParams } from "next/navigation"
import { CheckCircle2, Clock, XCircle, Loader2 } from "lucide-react"
import { shopService } from "@/lib/shop-service"
import { useShopBasePath } from "@/lib/shop-url"

export default function AfaConfirmationPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const shopSlug = params.slug as string
  const shopHome = useShopBasePath(shopSlug) || "/"
  const orderId = searchParams.get("orderId") || searchParams.get("reference")

  const [shop, setShop] = useState<any>(null)
  const [order, setOrder] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (shopSlug) shopService.getShopBySlug(shopSlug).then(setShop).catch(() => {})
    if (orderId) pollStatus()
  }, [shopSlug, orderId])

  const pollStatus = async () => {
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 2000))
        const res = await fetch(`/api/shop/afa/status?orderId=${orderId}`)
        const json = await res.json()
        if (json.data) {
          setOrder(json.data)
          if (json.data.payment_status === "completed") break
        }
      }
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/40">
        <div className="text-center space-y-3">
          <Loader2 className="w-10 h-10 animate-spin text-[#1b388b] mx-auto" />
          <p className="text-muted-foreground font-medium">Verifying your payment...</p>
        </div>
      </div>
    )
  }

  const paid = order?.payment_status === "completed"
  const fulfilled = order?.fulfillment_status === "fulfilled" || order?.order_status === "completed"

  return (
    <div className="min-h-screen bg-muted/40 flex items-center justify-center p-4">
      <div className="max-w-md w-full rounded-2xl border border-white/60 dark:border-white/5 bg-card p-6 text-center clay">
        {paid ? (
          <>
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-success/10 text-success mb-3"><CheckCircle2 className="h-7 w-7" /></span>
            <h1 className="text-lg font-bold text-foreground">Payment Received</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {fulfilled
                ? "Your AFA registration has been submitted."
                : "Your payment was successful — your AFA registration is being processed and you'll get an update soon."}
            </p>
          </>
        ) : (
          <>
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-warning/10 text-warning mb-3"><Clock className="h-7 w-7" /></span>
            <h1 className="text-lg font-bold text-foreground">Still Confirming</h1>
            <p className="mt-1 text-sm text-muted-foreground">We're still confirming your payment. If you completed checkout, this usually finalizes within a minute — refresh this page shortly.</p>
          </>
        )}
        {order?.full_name && (
          <div className="mt-4 rounded-xl bg-muted/40 p-3 text-left text-sm">
            <p><span className="text-muted-foreground">Name:</span> {order.full_name}</p>
            <p><span className="text-muted-foreground">Amount:</span> GH₵{Number(order.amount || 0).toFixed(2)}</p>
          </div>
        )}
        <a href={shopHome} className="mt-5 inline-block rounded-2xl bg-[#1b388b] px-6 py-2.5 text-sm font-bold text-white hover:bg-[#1b388b]/90">
          Back to {shop?.shop_name || "Shop"}
        </a>
      </div>
    </div>
  )
}
