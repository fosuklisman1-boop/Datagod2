"use client"

import { useRef, useState } from "react"
import { ArrowRight, CheckCircle2, Clock, Loader2, Phone, XCircle } from "lucide-react"
import { BILLERS, isValidAmountInput, type BillerKey } from "@/lib/bills/billers"
import { useCashbackRates } from "@/components/cashback/use-cashback-rates"
import { PriceSummary } from "@/components/cashback/PriceSummary"
import { billReceiveLabel, parsePriceChange, quoteForDisplay, type RatesResponse } from "@/lib/cashback/display"
import { classifyPayResponse } from "@/lib/bills/ui-helpers"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { supabase } from "@/lib/supabase"
import type { AvailabilityBiller } from "./use-bills-availability"

type Step = "input" | "meters" | "confirm" | "done"
interface Meter { meter: string; name: string | null; outstanding: number | null; token: string }
interface Picked { token: string; name: string | null; account: string; due: number | null }

const inputCls =
  "w-full rounded-2xl border border-white/60 dark:border-white/5 bg-background px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary clay-inset"
const labelCls = "block text-sm font-semibold text-foreground mb-1.5"
const money = (n: number) => `GHS ${n.toFixed(2)}`

export function BillLogo({ biller, size = 48 }: { biller: Pick<AvailabilityBiller, "logo" | "label">; size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={biller.logo}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-xl border border-border bg-white object-contain p-0.5"
      style={{ width: size, height: size }}
    />
  )
}

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

export function BillPayFlow({
  billers, balance, defaultPhone, onPaid,
}: {
  billers: AvailabilityBiller[]
  balance: number | null
  defaultPhone?: string
  onPaid: () => void
}) {
  const [active, setActive] = useState<AvailabilityBiller | null>(null)
  const { rates, ensureFresh } = useCashbackRates()

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {billers.map(b => (
          <button
            key={b.key}
            type="button"
            onClick={() => setActive(b)}
            className="flex flex-col items-start gap-3 rounded-3xl border border-white/60 dark:border-white/5 bg-card p-4 text-left transition hover:-translate-y-0.5 clay"
          >
            <BillLogo biller={b} size={64} />
            <span>
              <span className="block text-sm font-bold text-foreground">{b.label}</span>
              <span className="block text-xs text-muted-foreground">{b.inputHint}</span>
            </span>
          </button>
        ))}
      </div>
      {active && (
        <PaySheet
          key={active.key}
          biller={active}
          rates={rates}
          ensureFresh={ensureFresh}
          balance={balance}
          defaultPhone={defaultPhone}
          onClose={() => setActive(null)}
          onPaid={onPaid}
        />
      )}
    </>
  )
}

function PaySheet({
  biller, balance, defaultPhone, onClose, onPaid, rates, ensureFresh,
}: {
  rates: RatesResponse
  ensureFresh: () => Promise<RatesResponse>
  biller: AvailabilityBiller
  balance: number | null
  defaultPhone?: string
  onClose: () => void
  onPaid: () => void
}) {
  const key = biller.key
  const isEcg = key === "ecg"
  const isWater = key === "ghana_water"
  const isBroadband = key === "telecel_broadband"
  const needsPhone = isEcg || isWater

  const [step, setStep] = useState<Step>("input")
  const [account, setAccount] = useState("")
  const [phone, setPhone] = useState(defaultPhone ?? "")
  const [email, setEmail] = useState("")
  const [broadbandAccount, setBroadbandAccount] = useState("")
  const [consent, setConsent] = useState(false)
  const [addingMeter, setAddingMeter] = useState(false)
  const [meters, setMeters] = useState<Meter[]>([])
  const [picked, setPicked] = useState<Picked | null>(null)
  const [amount, setAmount] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [reference, setReference] = useState("")
  const [doneStatus, setDoneStatus] = useState("processing")
  const [serverPrice, setServerPrice] = useState<{ amount: number; pay: number; cashback: number } | null>(null)
  const payingRef = useRef(false)
  const verifyingRef = useRef(false)

  // The verify token is single-use: after a 400/409 the user must verify again.
  const backToInput = (msg: string) => {
    setPicked(null)
    setAmount("")
    setConsent(false)
    setStep(isEcg && meters.length > 0 ? "meters" : "input")
    setError(msg)
  }

  const goToConfirm = async (p: Picked, suggested: number) => {
    await ensureFresh() // re-fetch rates older than 5 minutes before the confirm step opens
    setServerPrice(null)
    setPicked(p)
    setAmount(suggested > 0 ? suggested.toFixed(2) : "")
    setError("")
    setStep("confirm")
  }

  const verify = async (opts: { addMeter?: boolean } = {}) => {
    if (verifyingRef.current) return
    verifyingRef.current = true
    setBusy(true)
    setError("")
    const { status, json } = await authedPost("/api/bills/verify", {
      biller: key,
      phone: needsPhone ? phone : undefined,
      account: isEcg && !opts.addMeter ? undefined : account,
      email: isWater ? email : undefined,
      broadbandAccount: isBroadband ? broadbandAccount : undefined,
      addMeter: isEcg ? opts.addMeter === true : undefined,
      consent: isEcg && opts.addMeter ? consent : undefined,
    })
    verifyingRef.current = false
    setBusy(false)
    if (status !== 200 || !json?.success) {
      setError(String(json?.error || "Could not verify. Please try again."))
      return
    }
    if (isEcg && !opts.addMeter) {
      const list: Meter[] = Array.isArray(json.meters) ? json.meters : []
      setMeters(list)
      if (list.length === 0) {
        setAddingMeter(true)
        setError("No meters are linked to this phone yet. Add your meter below.")
      } else {
        setAddingMeter(false)
      }
      setStep("meters")
      return
    }
    if (!json.token) {
      setError("Could not verify. Please try again.")
      return
    }
    goToConfirm(
      { token: json.token, name: json.customerName ?? null, account, due: json.amountDue ?? null },
      Number(json.suggestedAmount) || 0,
    )
  }

  const numAmount = Number(amount)
  const amountValid = isValidAmountInput(amount) && Number.isFinite(numAmount) && numAmount >= biller.min && numAmount <= biller.max
  const quote = quoteForDisplay(numAmount, rates.services[BILLERS[biller.key as BillerKey]?.serviceKey ?? ""])
  const forced = serverPrice && serverPrice.amount === numAmount ? serverPrice : null
  const cashbackOn = forced ? forced.cashback > 0 : quote.applied
  const payShown = forced ? forced.pay : quote.applied ? quote.pay : numAmount
  const insufficient = balance !== null && amountValid && payShown > balance

  const pay = async () => {
    if (payingRef.current || !picked || !amountValid) return
    payingRef.current = true
    setBusy(true)
    setError("")
    const { status, json } = await authedPost("/api/bills/pay", { token: picked.token, amount: numAmount, expectedPay: payShown })
    setBusy(false)
    const change = parsePriceChange(status, json)
    if (change) {
      // Definite non-charge and the verify token is unspent: show the new price and wait for another tap.
      setServerPrice({ amount: numAmount, pay: change.payAmount, cashback: change.customerCashback })
      setError(change.message)
      payingRef.current = false
      return
    }
    const outcome = classifyPayResponse(status, json)
    if (outcome.kind === "done") {
      setReference(outcome.reference)
      setDoneStatus(outcome.status)
      setStep("done")
      onPaid()
      return // payingRef stays true: this verification is spent
    }
    payingRef.current = false
    // 503/429 fail before an order is inserted, so the token is still good. Everything else
    // (timeouts, crashes, network errors) may have reached the server: never re-send the token.
    if (outcome.kind === "retry") { setError(outcome.message); return }
    backToInput(outcome.message)
  }

  const inputReady = isEcg
    ? phone.trim().length >= 9
    : isBroadband
      ? account.trim().length >= 4 && broadbandAccount.trim().length >= 3
      : isWater
        ? account.trim().length >= 4 && phone.trim().length >= 9 && email.trim().includes("@")
        : account.trim().length >= 4

  return (
    <Sheet open onOpenChange={o => { if (!o && !busy) onClose() }}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[92vh] overflow-y-auto rounded-t-3xl border-0 bg-card p-5 pb-8 sm:max-w-xl"
      >
        <SheetHeader className="flex-row items-center gap-3 space-y-0 p-0 pr-10 text-left">
          <BillLogo biller={biller} size={48} />
          <div>
            <SheetTitle className="text-base font-bold">{biller.label}</SheetTitle>
            <SheetDescription className="text-xs">
              Pay with your wallet · GHS {biller.min}–{biller.max}
            </SheetDescription>
          </div>
        </SheetHeader>

        <div className="mt-5 space-y-4">
          {step === "input" && (
            <form onSubmit={e => { e.preventDefault(); if (inputReady && !busy) verify() }} className="space-y-4">
              {isEcg ? (
                <PhoneField value={phone} onChange={setPhone} hint="We'll look up the meters linked to this phone number with ECG." />
              ) : isBroadband ? (
                <>
                  <div>
                    <label className={labelCls}>Landline number</label>
                    <input className={inputCls} inputMode="numeric" placeholder="0302450262" value={account} onChange={e => { setAccount(e.target.value); setConsent(false) }} />
                  </div>
                  <div>
                    <label className={labelCls}>Broadband account number</label>
                    <input className={inputCls} placeholder="P0444101" value={broadbandAccount} onChange={e => setBroadbandAccount(e.target.value)} />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className={labelCls}>{biller.inputHint}</label>
                    <input className={inputCls} placeholder={biller.inputHint} value={account} onChange={e => { setAccount(e.target.value); setConsent(false) }} />
                  </div>
                  {isWater && (
                    <>
                      <PhoneField value={phone} onChange={setPhone} hint="Ghana Water needs your phone to verify the meter." />
                      <div>
                        <label className={labelCls}>Email</label>
                        <input className={inputCls} type="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} />
                      </div>
                    </>
                  )}
                </>
              )}
              <ErrorLine msg={error} />
              <button type="submit" disabled={!inputReady || busy} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-4 text-sm font-bold text-primary-foreground transition disabled:opacity-50">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <>{isEcg ? "Find my meters" : "Verify account"} <ArrowRight className="h-4 w-4" /></>}
              </button>
            </form>
          )}

          {step === "meters" && (
            <div className="space-y-3">
              {meters.length > 0 && <p className="text-sm font-semibold text-foreground">Select a meter</p>}
              {meters.map(m => (
                <button
                  key={m.meter}
                  type="button"
                  onClick={() => goToConfirm({ token: m.token, name: m.name, account: m.meter, due: m.outstanding }, m.outstanding && m.outstanding > 0 ? m.outstanding : 0)}
                  className="flex w-full items-center justify-between gap-3 rounded-2xl border border-white/60 dark:border-white/5 bg-background p-4 text-left clay-sm"
                >
                  <span>
                    <span className="block text-sm font-bold text-foreground">{m.name || "ECG meter"}</span>
                    <span className="block font-mono text-xs text-muted-foreground">{m.meter}</span>
                  </span>
                  {m.outstanding !== null && m.outstanding > 0 && (
                    <span className="text-right text-xs text-muted-foreground">
                      Outstanding
                      <span className="block text-sm font-bold text-foreground">{money(m.outstanding)}</span>
                    </span>
                  )}
                </button>
              ))}
              {!addingMeter ? (
                <button type="button" onClick={() => { setAddingMeter(true); setError("") }} className="w-full rounded-2xl border border-dashed border-border py-3 text-sm font-semibold text-primary">
                  + Add another meter
                </button>
              ) : (
                <form onSubmit={e => { e.preventDefault(); if (account.trim().length >= 4 && consent && !busy) verify({ addMeter: true }) }} className="space-y-3 rounded-2xl border border-border p-4">
                  <label className={labelCls}>Meter number</label>
                  <input className={inputCls} placeholder="Meter number" value={account} onChange={e => { setAccount(e.target.value); setConsent(false) }} />
                  <label className="flex items-start gap-2 text-xs text-muted-foreground">
                    <input type="checkbox" className="mt-0.5" checked={consent} onChange={e => setConsent(e.target.checked)} />
                    <span>This links meter {account.trim() || "—"} to phone {phone} with ECG</span>
                  </label>
                  <button type="submit" disabled={account.trim().length < 4 || !consent || busy} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-3.5 text-sm font-bold text-primary-foreground disabled:opacity-50">
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Verify meter <ArrowRight className="h-4 w-4" /></>}
                  </button>
                </form>
              )}
              <ErrorLine msg={error} />
              <button type="button" onClick={() => { setStep("input"); setError("") }} className="w-full text-xs font-medium text-muted-foreground">Use a different phone number</button>
            </div>
          )}

          {step === "confirm" && picked && (
            <div className="space-y-4">
              <div className="space-y-2 rounded-2xl border border-white/60 dark:border-white/5 bg-background p-4 text-sm clay-sm">
                <Row k="Customer" v={picked.name || "Unverified — entered manually"} />
                <Row k="Account" v={isBroadband ? `${picked.account} / ${broadbandAccount}` : picked.account} mono />
                {picked.due !== null && picked.due > 0 && <Row k="Amount due" v={money(picked.due)} />}
                {balance !== null && <Row k="Wallet balance" v={money(balance)} />}
              </div>
              <div>
                <div className="mb-1.5 flex items-baseline justify-between">
                  <label className="text-sm font-semibold text-foreground">Amount (GHS)</label>
                  <span className="text-xs text-muted-foreground">Min {biller.min} · Max {biller.max}</span>
                </div>
                <input className={`${inputCls} text-lg font-semibold`} type="number" inputMode="decimal" min={biller.min} max={biller.max} step="0.01" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} />
                {amount !== "" && !amountValid && <p className="mt-1 text-xs text-destructive">Amount must be between GHS {biller.min} and GHS {biller.max}.</p>}
                {insufficient && !cashbackOn && <p className="mt-1 text-xs font-medium text-destructive">Insufficient wallet balance.</p>}
              </div>
              {amountValid && cashbackOn && (
                <div className="rounded-2xl border border-white/60 dark:border-white/5 bg-background p-4 clay-sm">
                  <PriceSummary pay={payShown} receive={billReceiveLabel(biller.label, numAmount, picked.account)} balance={balance} />
                </div>
              )}
              <ErrorLine msg={error} />
              <button type="button" onClick={pay} disabled={busy || !amountValid || insufficient} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-4 text-sm font-bold text-primary-foreground transition disabled:opacity-50">
                {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Processing…</> : <>Pay {amountValid ? money(payShown) : "GHS 0.00"}</>}
              </button>
              <button type="button" onClick={() => { setStep(isEcg ? "meters" : "input"); setError("") }} disabled={busy} className="w-full text-xs font-medium text-muted-foreground">Back</button>
            </div>
          )}

          {step === "done" && (
            <div className="space-y-4 py-2 text-center">
              {doneStatus === "failed" ? (
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-destructive/15"><XCircle className="h-9 w-9 text-destructive" /></div>
              ) : doneStatus === "completed" ? (
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-success/15"><CheckCircle2 className="h-9 w-9 text-success" /></div>
              ) : (
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-warning/15"><Clock className="h-9 w-9 text-warning" /></div>
              )}
              <div>
                <h3 className="text-lg font-bold text-foreground">{doneStatus === "completed" ? "Completed" : doneStatus === "failed" ? "Payment failed" : "Processing"}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{doneStatus === "completed" ? "Your bill has been paid." : doneStatus === "failed" ? "Payment failed — under review; a refund follows if nothing was delivered." : "Processing — we'll notify you when it completes."}</p>
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

function PhoneField({ value, onChange, hint }: { value: string; onChange: (v: string) => void; hint: string }) {
  return (
    <div>
      <label className={labelCls}>Phone number</label>
      <div className="relative">
        <Phone className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input className={`${inputCls} pl-11 font-mono`} type="tel" inputMode="tel" placeholder="024XXXXXXX" value={value} onChange={e => onChange(e.target.value)} />
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{k}</span>
      <span className={`text-right font-semibold text-foreground ${mono ? "font-mono text-xs" : ""}`}>{v}</span>
    </div>
  )
}

function ErrorLine({ msg }: { msg: string }) {
  if (!msg) return null
  return <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive">{msg}</p>
}
