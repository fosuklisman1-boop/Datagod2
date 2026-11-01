"use client"

import { useRef, useState } from "react"
import Link from "next/link"
import { CheckCircle2, Clock, Loader2, Phone, XCircle } from "lucide-react"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { supabase } from "@/lib/supabase"
import {
  classifyBuyResponse, formatGhs, keyAfterPhoneEdit, recipientIdentity, shouldRotateIdempotencyKey, validateBundleRecipient,
  type PrefixRules,
} from "@/lib/standard-bundles/ui-helpers"
import { newUuid } from "@/lib/standard-bundles/uuid"
import { NETWORK_SERVICE } from "@/lib/standard-bundles/categories"
import { bundleReceiveLabel, parsePriceChange, priceLabel, type RatesResponse } from "@/lib/cashback/display"
import { bundleCardPrice, specialBreakdown, type SpecialInfo } from "@/lib/standard-bundles/special-ui"
import { PriceSummary } from "@/components/cashback/PriceSummary"

export interface PickedBundle {
  token: string
  display: string
  amount: number
  network: "MTN" | "TELECEL" | "AT"
  networkLabel: string
  /** Catalog category ("Midnight Bundles"), shown in "You receive". */
  category?: string
  /** Special Bundles only: N × the unit bundle. */
  special?: SpecialInfo
}

type Step = "input" | "done"

const inputCls =
  "w-full rounded-2xl border border-white/60 dark:border-white/5 bg-background px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary clay-inset"
const money = formatGhs

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function authedPost(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return { status: 401, json: { error: "Please sign in again" } }
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    return { status: res.status, json }
  } catch {
    return { status: 0, json: { error: "Network error. Please try again." } }
  }
}

export function BundleBuySheet({
  bundle, rates, balance, defaultPhone, prefixRules, onClose, onChanged, onStale,
}: {
  bundle: PickedBundle
  rates: RatesResponse
  balance: number | null
  defaultPhone?: string
  /** Live admin prefix map + toggle; null while loading or when the fetch failed (then only the server checks). */
  prefixRules: PrefixRules | null
  onClose: () => void
  /** A purchase went through (or may have): refresh wallet + orders. */
  onChanged: () => void
  /** 409: the signed bundle is no longer valid; the page reloads the catalog, shows the message and closes the sheet. */
  onStale: (message: string) => void
}) {
  const [step, setStep] = useState<Step>("input")
  const [phone, setPhone] = useState(defaultPhone ?? "")
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [insufficient, setInsufficient] = useState(false)
  const [stale, setStale] = useState(false)
  const [serverPrice, setServerPrice] = useState<{ pay: number; cashback: number } | null>(null)
  const [reference, setReference] = useState("")
  const [doneStatus, setDoneStatus] = useState("processing")
  // Generated once when the sheet opens (this component mounts per open); regenerated after a definite non-delivery.
  const keyRef = useRef<string>("")
  if (!keyRef.current) keyRef.current = newUuid()
  // The recipient + key of the last request, so returning to that number reuses its key (a retry then dedupes).
  const lastAttemptRef = useRef<{ recipient: string; key: string } | null>(null)
  const buyingRef = useRef(false)

  const phoneError = validateBundleRecipient(bundle.network, phone, prefixRules)
  // Special: n × the per-unit display price (matches the server's per-unit rounding); normal: quoteForDisplay(amount).
  const quote = bundleCardPrice(bundle, rates.services[NETWORK_SERVICE[bundle.network]])
  const cashbackOn = serverPrice ? serverPrice.cashback > 0 : quote.applied
  const payShown = serverPrice ? serverPrice.pay : quote.pay
  const face = quote.face
  /** "1.22GB (3 × 406.89MB)" for Special, else the display as before. */
  const sizeLabel = bundle.special ? `${bundle.display} (${specialBreakdown(bundle.special)})` : bundle.display
  const lowBalance = balance !== null && payShown > balance

  const buy = async () => {
    if (buyingRef.current || phoneError || lowBalance) return
    buyingRef.current = true
    setBusy(true)
    setError("")
    setInsufficient(false)
    const sentPhone = phone.trim()
    const { status, json } = await authedPost("/api/standard-bundles/buy", {
      token: bundle.token,
      phone: sentPhone,
      idempotencyKey: keyRef.current,
      expectedPay: payShown,
    })
    // The request has settled. Rotate only after a definite non-delivery; uncertain outcomes keep the key so a retry dedupes.
    if (shouldRotateIdempotencyKey(status, json)) keyRef.current = newUuid()
    lastAttemptRef.current = { recipient: recipientIdentity(sentPhone), key: keyRef.current }
    setBusy(false)
    buyingRef.current = false
    const change = parsePriceChange(status, json)
    if (change) {
      // Definite non-charge (key rotated above): show the new price and wait for another tap.
      setServerPrice({ pay: change.payAmount, cashback: change.customerCashback })
      setError(change.message)
      return
    }
    const outcome = classifyBuyResponse(status, json)
    switch (outcome.kind) {
      case "done":
        setReference(outcome.reference)
        setDoneStatus(outcome.status)
        setStep("done")
        buyingRef.current = true // this purchase is spent
        onChanged()
        return
      case "refresh":
        // Buy stays disabled until the page has reloaded the catalog and closed this sheet for a re-pick.
        setStale(true)
        setError(outcome.message)
        onStale(outcome.message)
        return
      case "insufficient":
        setInsufficient(true)
        setError(outcome.message)
        return
      case "unconfirmed":
        setError(outcome.message)
        onChanged()
        return
      default:
        setError(outcome.message)
    }
  }

  return (
    <Sheet open onOpenChange={o => { if (!o && !busy) onClose() }}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[92dvh] overflow-y-auto rounded-t-3xl border-0 bg-card p-5 pb-8 sm:max-w-xl"
      >
        <SheetHeader className="space-y-1 p-0 pr-10 text-left">
          <SheetTitle className="text-base font-bold">{bundle.networkLabel} {sizeLabel}</SheetTitle>
          <SheetDescription className="text-xs">Pay with your wallet · {cashbackOn ? priceLabel(face, { pay: payShown, cashback: face - payShown, applied: true }) : money(payShown)}</SheetDescription>
        </SheetHeader>

        <div className="mt-5 space-y-4">
          {step === "input" && (
            <form onSubmit={e => { e.preventDefault(); setTouched(true); if (!busy) buy() }} className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-foreground">Recipient number</label>
                <div className="relative">
                  <Phone className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    className={`${inputCls} pl-11 font-mono`}
                    type="tel"
                    inputMode="tel"
                    placeholder="024XXXXXXX"
                    value={phone}
                    onChange={e => {
                      // A different recipient is a different purchase (new key); reformatting the same number is not.
                      // Never change the key while a request is in flight.
                      const next = e.target.value
                      if (!buyingRef.current) {
                        keyRef.current = keyAfterPhoneEdit({
                          prevPhone: phone, nextPhone: next, currentKey: keyRef.current, lastAttempt: lastAttemptRef.current, newKey: newUuid,
                        })
                      }
                      setPhone(next)
                    }}
                    onBlur={() => setTouched(true)}
                  />
                </div>
                {touched && phoneError && <p className="mt-1 text-xs text-destructive">{phoneError}</p>}
              </div>

              <div className="space-y-2 rounded-2xl border border-white/60 dark:border-white/5 bg-background p-4 text-sm clay-sm">
                {cashbackOn ? (
                  <PriceSummary pay={payShown} receive={bundleReceiveLabel(bundle.category, sizeLabel)} balance={balance} />
                ) : (
                  <>
                    <Row k="Bundle" v={`${bundle.networkLabel} ${sizeLabel}`} />
                    <Row k="Price" v={money(payShown)} />
                    {balance !== null && <Row k="Wallet balance" v={money(balance)} />}
                  </>
                )}
              </div>

              {lowBalance && (
                <p className="text-xs font-medium text-destructive">
                  Insufficient wallet balance. <Link href="/dashboard/wallet" className="underline">Top up</Link>
                </p>
              )}
              {error && (
                <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive">
                  {error}{" "}
                  {insufficient && <Link href="/dashboard/wallet" className="underline">Top up</Link>}
                </p>
              )}

              <button
                type="submit"
                disabled={busy || stale || !!phoneError || lowBalance}
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-4 text-sm font-bold text-primary-foreground transition disabled:opacity-50"
              >
                {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Processing…</> : <>Buy {money(payShown)}</>}
              </button>
            </form>
          )}

          {step === "done" && (
            <div className="space-y-4 py-2 text-center">
              {doneStatus === "completed" ? (
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-success/15"><CheckCircle2 className="h-9 w-9 text-success" /></div>
              ) : doneStatus === "failed" ? (
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-destructive/15"><XCircle className="h-9 w-9 text-destructive" /></div>
              ) : (
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-warning/15"><Clock className="h-9 w-9 text-warning" /></div>
              )}
              <div>
                <h3 className="text-lg font-bold text-foreground">{doneStatus === "completed" ? "Delivered" : "Processing"}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {doneStatus === "completed"
                    ? `${sizeLabel} has been sent to ${phone.trim()}.`
                    : "Processing — we'll notify you when it completes."}
                </p>
                {reference && <p className="mt-2 font-mono text-xs text-muted-foreground">Ref: {reference}</p>}
              </div>
              <button type="button" onClick={onClose} className="w-full rounded-2xl bg-primary py-3.5 text-sm font-bold text-primary-foreground">Done</button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right font-semibold text-foreground">{v}</span>
    </div>
  )
}
