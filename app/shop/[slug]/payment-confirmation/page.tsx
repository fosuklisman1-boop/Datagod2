"use client"

import { useEffect, useState } from "react"
import { useParams, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { CheckCircle2, AlertCircle, Loader2, RotateCcw } from "lucide-react"
import { shopService } from "@/lib/shop-service"
import { useShopBasePath } from "@/lib/shop-url"
import { isFinalView, orderView, type OrderView } from "@/lib/storefront-commission/ui-helpers"

const POLL_MS = 3000
const POLL_MAX_MS = 2 * 60 * 1000

/**
 * Where Paystack returns a storefront Bundles (cs_bundle) payment:
 * /shop/<slug>/payment-confirmation?reference=<32hex>&orderId=<uuid>.
 * Verifies the payment (idempotent, shared with the webhook), then polls the public order-status endpoint.
 * Wording stays neutral: no product details are shown or sent anywhere.
 */
export default function PaymentConfirmationPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const shopSlug = params.slug as string
  const shopHome = useShopBasePath(shopSlug) || "/"
  const reference = searchParams.get("reference") || searchParams.get("trxref")
  const orderId = searchParams.get("orderId")

  const [accent, setAccent] = useState("#1b388b")
  const [view, setView] = useState<OrderView | "checking">("checking")
  const [stalled, setStalled] = useState(false)

  useEffect(() => {
    shopService.getShopBySlug(shopSlug).then((s: any) => { if (s?.custom_color) setAccent(s.custom_color) }).catch(() => {})
  }, [shopSlug])

  useEffect(() => {
    if (!orderId) { setView("failed"); return }
    let cancelled = false
    const started = Date.now()

    const poll = async () => {
      if (cancelled) return
      try {
        const res = await fetch(`/api/shop/commission/order?orderId=${encodeURIComponent(orderId)}&shop=${encodeURIComponent(shopSlug)}`, { cache: "no-store" })
        if (res.ok) {
          const d = await res.json()
          const v = orderView(d?.status, d?.paymentStatus)
          if (!cancelled) setView(v)
          if (isFinalView(v)) return
        }
      } catch { /* keep polling */ }
      if (Date.now() - started > POLL_MAX_MS) { if (!cancelled) setStalled(true); return }
      setTimeout(poll, POLL_MS)
    }

    const run = async () => {
      if (reference) {
        try {
          await fetch("/api/payments/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reference }),
          })
        } catch { /* the webhook may still confirm it; polling below shows the truth */ }
      }
      await poll()
    }
    run()
    return () => { cancelled = true }
  }, [orderId, reference, shopSlug])

  const effective: OrderView | "checking" = view === "awaiting_payment" && stalled ? "failed" : view

  return (
    <div className="flex min-h-screen items-center justify-center bg-card px-4" style={{ "--shop-accent": accent } as React.CSSProperties}>
      <div className="w-full max-w-md space-y-5 text-center">
        {effective === "delivered" ? (
          <>
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-success/15"><CheckCircle2 className="h-9 w-9 text-success" /></div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Delivered</h1>
              <p className="mt-1 text-sm text-muted-foreground">Your order has been delivered. Thank you!</p>
            </div>
          </>
        ) : effective === "refunding" || effective === "refunded" ? (
          <>
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-muted"><RotateCcw className="h-9 w-9 text-foreground" /></div>
            <div>
              <h1 className="text-xl font-bold text-foreground">{effective === "refunded" ? "Refunded" : "Refund in progress"}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {effective === "refunded"
                  ? "We could not complete this order, so your payment has been refunded."
                  : "We could not complete this order. Your refund is being processed."}
                {reference ? <> Payment reference: <span className="font-mono text-xs">{reference}</span></> : null}
              </p>
            </div>
          </>
        ) : effective === "failed" ? (
          <>
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-destructive/15"><AlertCircle className="h-9 w-9 text-destructive" /></div>
            <div>
              <h1 className="text-xl font-bold text-foreground">We could not complete this order</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                It is under review. If you were charged, we will sort it out or refund you. Keep your payment reference handy
                {reference ? <>: <span className="font-mono text-xs">{reference}</span></> : null}.
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[var(--shop-accent)]">
              <Loader2 className="h-8 w-8 animate-spin text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Processing</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {stalled
                  ? "This is taking a little longer than usual. You can close this page; your order will still be completed."
                  : "Payment received. We are completing your order. Please keep this page open."}
              </p>
            </div>
          </>
        )}
        <Button asChild className="w-full rounded-2xl bg-[var(--shop-accent)] text-white hover:bg-[var(--shop-accent)]/90">
          <a href={shopHome}>Back to shop</a>
        </Button>
      </div>
    </div>
  )
}
