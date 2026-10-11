"use client"

import { useState } from "react"
import { toast } from "sonner"
import { CheckCircle, CreditCard, Gift, Loader2, Lock, Smartphone, Wallet } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { smsFetch } from "../_lib/api"
import { useSmsAccount } from "../_lib/useSmsAccount"
import { MomoDialog, useWalletGates } from "./MomoDialog"

/**
 * Welcome-bonus claim banner (active, non-platform, bonus unclaimed) OR the
 * activation card (inactive, non-platform, not suspended). Renders nothing
 * otherwise. Self-contained: reads the account from context and calls
 * `reload()` after a successful action. No props.
 */
export function ActivationCard() {
  const { account, reload } = useSmsAccount()
  const { walletDirect, walletOtp } = useWalletGates()
  const [busy, setBusy] = useState(false)
  const [momoOpen, setMomoOpen] = useState(false)

  if (!account) return null
  const isActive = account.status === "active"
  const isSuspended = account.status === "suspended"
  const isPlatform = account.ownerType === "platform"
  const showActivation = !isPlatform && !isActive && !isSuspended
  // Welcome bonus is a tenant perk — never offered to the platform/admin account.
  const showBonus = isActive && !isPlatform && !account.bonusClaimed

  async function activate(paidFrom: "wallet" | "paystack") {
    setBusy(true)
    const res = await smsFetch("/api/sms/activate", { method: "POST", body: JSON.stringify({ paidFrom }) })
    setBusy(false)
    if (!res.ok) {
      toast.error(res.error === "INSUFFICIENT_BALANCE"
        ? "Insufficient wallet balance. Top up your wallet or pay with Paystack." : res.error)
      return
    }
    const url = res.body.authorizationUrl
    if (typeof url === "string" && url) { window.location.href = url; return }
    toast.success("Account activated! Welcome to SMS.")
    await reload()
  }

  async function claimBonus() {
    setBusy(true)
    const res = await smsFetch("/api/sms/claim-bonus", { method: "POST" })
    setBusy(false)
    if (!res.ok) { toast.error(res.error === "ALREADY_CLAIMED" ? "Bonus already claimed." : res.error); return }
    if (res.body.pending) toast.info(`${res.body.unitsCredited} bonus credits queued — awaiting SMS supply top-up.`)
    else { toast.success(`${res.body.unitsCredited} bonus SMS credits added!`); await reload() }
  }

  return (
    <>
      {showBonus && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
          <div className="flex items-center gap-2">
            <Gift className="h-5 w-5 shrink-0 text-amber-600" />
            <div>
              <p className="text-sm font-bold text-foreground">Claim your {account.welcomeBonusCredits} free SMS credits!</p>
              <p className="text-xs text-muted-foreground">Welcome bonus for activating the SMS feature.</p>
            </div>
          </div>
          <Button size="sm" onClick={claimBonus} disabled={busy} className="shrink-0 bg-amber-500 text-white hover:bg-amber-600">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Gift className="h-4 w-4" />} Claim
          </Button>
        </div>
      )}

      {showActivation && (
        <>
          <Card className="overflow-hidden border-success/30">
            <CardContent className="space-y-4 pt-6 text-center">
              <div className="clay-icon mx-auto grid h-14 w-14 place-items-center bg-success/10">
                <Lock className="h-7 w-7 text-success" />
              </div>
              <div>
                <p className="text-lg font-bold text-foreground">Unlock Customer SMS</p>
                <p className="text-sm text-muted-foreground">One-time activation, then pay-as-you-go with SMS bundles.</p>
              </div>
              {account.welcomeBonusCredits > 0 && !account.bonusClaimed && (
                <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700">
                  <Gift className="mr-1 inline h-3.5 w-3.5" /> Activate now and get {account.welcomeBonusCredits} free SMS credits to get started!
                </p>
              )}
              <ul className="space-y-1.5 rounded-lg bg-muted/30 p-3 text-left text-sm">
                <li className="flex items-center gap-2"><CheckCircle className="h-4 w-4 shrink-0 text-success" /> Bulk SMS to your entire customer list in one tap</li>
                <li className="flex items-center gap-2"><CheckCircle className="h-4 w-4 shrink-0 text-success" /> Single SMS to any Ghana number</li>
                <li className="flex items-center gap-2"><CheckCircle className="h-4 w-4 shrink-0 text-success" /> Live character &amp; cost counter — no surprises</li>
                <li className="flex items-center gap-2"><CheckCircle className="h-4 w-4 shrink-0 text-success" /> Failed messages are automatically refunded</li>
              </ul>
              {account.activationFee > 0 && (
                <>
                  <p className="text-3xl font-black text-success">GH₵{account.activationFee.toFixed(2)}</p>
                  <p className="-mt-3 text-xs text-muted-foreground">one-time activation fee</p>
                </>
              )}
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => activate("wallet")} disabled={busy} className="bg-success text-white hover:bg-success/90">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />} {account.activationFee === 0 ? "Activate" : `Activate for GH₵${account.activationFee.toFixed(2)}`}
                </Button>
                {account.activationFee > 0 && (
                  walletDirect ? (
                    <Button variant="outline" onClick={() => setMomoOpen(true)} disabled={busy}><Smartphone className="h-4 w-4" /> Pay with MoMo</Button>
                  ) : (
                    <Button variant="outline" onClick={() => activate("paystack")} disabled={busy}><CreditCard className="h-4 w-4" /> Pay with Paystack</Button>
                  )
                )}
              </div>
            </CardContent>
          </Card>
          <MomoDialog open={momoOpen} onClose={() => setMomoOpen(false)} cost={account.activationFee} walletOtp={walletOtp} />
        </>
      )}
    </>
  )
}
