"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { AlertCircle, Loader2, Plus, Wallet } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { smsFetch } from "../../_lib/api"
import { useSmsAccount } from "../../_lib/useSmsAccount"
import {
  bestValueId, buyBlockedReason, buyErrorMessage, formatCount, perSms, purchaseMethod, purchaseOutcome, walletShortfall,
} from "../../_lib/view"

interface Bundle { id: string; name: string; units: number; price_ghs: number }

export function BundleCards() {
  const { account, featureEnabled, walletBalance, profitBalance, reload } = useSmsAccount()
  const [bundles, setBundles] = useState<Bundle[]>([])
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [buyingBundleId, setBuyingBundleId] = useState<string | null>(null)
  const buying = useRef(false)
  const alive = useRef(true)

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback(async () => {
    const r = await smsFetch<Bundle[]>("/api/sms/bundles")
    if (!alive.current) return
    const list = r.ok ? (r.body.bundles as Bundle[] | undefined) : undefined
    if (Array.isArray(list)) { setBundles(list); setFailed(false) } else { setFailed(true) }
    setLoaded(true)
  }, [])

  useEffect(() => { void load() }, [load])

  const blocked = buyBlockedReason({ featureEnabled, status: account?.status })
  const best = bestValueId(bundles)

  async function buy(b: Bundle) {
    if (buying.current || blocked) return
    buying.current = true
    setBuyingBundleId(b.id)
    try {
      const method = purchaseMethod(walletBalance, b.price_ghs)
      const endpoint = method === "wallet" ? "/api/sms/units/purchase-wallet" : "/api/sms/units/purchase-paystack"
      const r = await smsFetch(endpoint, { method: "POST", body: JSON.stringify({ bundleId: b.id }) })
      if (!r.ok) { toast.error(buyErrorMessage(r.error, r.code)); return }
      const out = purchaseOutcome(r.body as { authorizationUrl?: unknown; pending?: unknown })
      if (out.kind === "redirect" && out.url) { window.location.href = out.url; return }
      if (out.kind === "pending") toast.info("Payment received — credits pending SMS supply top-up.")
      else toast.success("SMS credits added!")
      await reload()
    } finally {
      buying.current = false
      if (alive.current) setBuyingBundleId(null)
    }
  }

  return (
    <section className="space-y-4" aria-label="Buy credits">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground"><Wallet className="h-4 w-4" /> Buy Credits</p>
        <div className="flex gap-1.5">
          <span className="rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-muted-foreground">
            Profit Wallet GH₵{profitBalance.toFixed(2)}
          </span>
          <span className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
            Main Wallet GH₵{walletBalance.toFixed(2)}
          </span>
        </div>
      </div>

      {blocked && (
        <Alert><AlertCircle className="h-4 w-4" /><AlertDescription>{blocked}</AlertDescription></Alert>
      )}

      {!loaded ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-36 w-full" />)}
        </div>
      ) : failed ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>Couldn’t load credit bundles.</span>
            <Button size="sm" variant="outline" onClick={() => { void load() }}>Retry</Button>
          </AlertDescription>
        </Alert>
      ) : bundles.length === 0 ? (
        <p className="text-sm text-muted-foreground">No bundles are available right now — check back later.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {bundles.map((b) => {
            const short = walletShortfall(walletBalance, b.price_ghs)
            const isBuying = buyingBundleId === b.id
            const isBest = best === b.id
            return (
              <Card key={b.id} className={isBest ? "border-primary ring-1 ring-primary/40" : undefined}>
                <CardContent className="space-y-1.5 pt-4">
                  <div className="flex items-center justify-between gap-1">
                    <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Credits</p>
                    {isBest && <Badge className="px-1.5 py-0 text-[10px]">Best value</Badge>}
                  </div>
                  <p className="text-xl font-bold">{formatCount(b.units)}</p>
                  <p className="text-lg font-bold text-success">GH₵{b.price_ghs.toFixed(2)}</p>
                  <p className="text-[10px] text-muted-foreground">≈ GH₵{perSms(b.price_ghs, b.units).toFixed(3)}/SMS</p>
                  {short > 0 ? (
                    <p className="text-[10px] text-amber-600">Need GH₵{short.toFixed(2)} more — pay with Paystack</p>
                  ) : (
                    <p className="text-[10px] text-success">Covered by Main Wallet</p>
                  )}
                  <Button
                    size="sm"
                    className="w-full"
                    disabled={!!blocked || buyingBundleId !== null}
                    onClick={() => { void buy(b) }}
                  >
                    {isBuying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Buy
                  </Button>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Paid from your main wallet (or Paystack). 1 credit = 1 SMS segment. Failed deliveries are refunded.
      </p>
    </section>
  )
}
