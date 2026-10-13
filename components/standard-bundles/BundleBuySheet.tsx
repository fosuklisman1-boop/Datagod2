"use client"

import { useRef, useState } from "react"
import Link from "next/link"
import { CheckCircle2, Clock, Loader2, Phone, XCircle } from "lucide-react"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { supabase } from "@/lib/supabase"
import { classifyBuyResponse, shouldRotateIdempotencyKey, validateBundleRecipient } from "@/lib/standard-bundles/ui-helpers"

export interface PickedBundle {
  token: string
  display: string
  amount: number
  network: "MTN" | "TELECEL" | "AT"
  networkLabel: string
}

type Step = "input" | "done"

const inputCls =
  "w-full rounded-2xl border border-white/60 dark:border-white/5 bg-background px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary clay-inset"
const money = (n: number) => `GHS ${n.toFixed(2)}`

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
  bundle, balance, defaultPhone, onClose, onChanged, onStale,
}: {
  bundle: PickedBundle
  balance: number | null
  defaultPhone?: string
  onClose: () => void
  /** A purchase went through (or may have): refresh wallet + orders. */
  onChanged: () => void
  /** 409: the signed bundle is no longer valid; reload the catalog. */
  onStale: () => void
}) {
  const [step, setStep] = useState<Step>("input")
  const [phone, setPhone] = useState(defaultPhone ?? "")
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [insufficient, setInsufficient] = useState(false)
  const [stale, setStale] = useState(false)
  const [reference, setReference] = useState("")
  const [doneStatus, setDoneStatus] = useState("processing")
  // Generated once when the sheet opens (this component mounts per open); regenerated after a non-2xx or failed order.
  const keyRef = useRef<string>(crypto.randomUUID())
  const buyingRef = useRef(false)

  const phoneError = validateBundleRecipient(bundle.network, phone)
  const lowBalance = balance !== null && bundle.amount > balance

  const buy = async () => {
    if (buyingRef.current || phoneError || lowBalance) return
    buyingRef.current = true
    setBusy(true)
    setError("")
    setInsufficient(false)
    const { status, json } = await authedPost("/api/standard-bundles/buy", {
      token: bundle.token,
      phone: phone.trim(),
      idempotencyKey: keyRef.current,
    })
    // The request has settled. Rotate only after a definite non-delivery; uncertain outcomes keep the key so a retry dedupes.
    if (shouldRotateIdempotencyKey(status, json)) keyRef.current = crypto.randomUUID()
    setBusy(false)
    buyingRef.current = false
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
        setStale(true)
        setError(outcome.message)
        onStale()
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
        className="mx-auto max-h-[92vh] overflow-y-auto rounded-t-3xl border-0 bg-card p-5 pb-8 sm:max-w-xl"
      >
        <SheetHeader className="space-y-1 p-0 pr-10 text-left">
          <SheetTitle className="text-base font-bold">{bundle.networkLabel} {bundle.display}</SheetTitle>
          <SheetDescription className="text-xs">Pay with your wallet · {money(bundle.amount)}</SheetDescription>
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
                      // A different recipient is a different purchase: never reuse the key (never while in flight).
                      if (!buyingRef.current) keyRef.current = crypto.randomUUID()
                      setPhone(e.target.value)
                    }}
                    onBlur={() => setTouched(true)}
                  />
                </div>
                {touched && phoneError && <p className="mt-1 text-xs text-destructive">{phoneError}</p>}
              </div>

              <div className="space-y-2 rounded-2xl border border-white/60 dark:border-white/5 bg-background p-4 text-sm clay-sm">
                <Row k="Bundle" v={`${bundle.networkLabel} ${bundle.display}`} />
                <Row k="Price" v={money(bundle.amount)} />
                {balance !== null && <Row k="Wallet balance" v={money(balance)} />}
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
                {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Processing…</> : <>Buy {money(bundle.amount)}</>}
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
                    ? `${bundle.display} has been sent to ${phone.trim()}.`
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
