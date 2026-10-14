"use client"

import { useRef, useState } from "react"
import { ArrowRight, Loader2, Phone, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import TurnstileWidget from "@/components/shop/TurnstileWidget"
import HoneypotField from "@/components/shop/HoneypotField"
import { PriceSummary } from "@/components/cashback/PriceSummary"
import { EcgMeterInput } from "@/components/bills/BillPayFlow"
import { PayerOtpStep, usePayerOtp } from "@/components/storefront-commission/PayerOtp"
import { MomoPayerHint, NOT_MOMO } from "@/components/storefront-commission/MomoPayerHint"
import { useStorefrontPayment } from "@/components/storefront-commission/DirectMomo"
import { useTurnstileGate } from "@/components/storefront-commission/use-turnstile-gate"
import { billReceiveLabel, parsePriceChange } from "@/lib/cashback/display"
import { BILLER_KEYS } from "@/lib/bills/billers"
import {
  billNeedsReverify, billStorefrontPrice, isOtpRequiredResponse, momoNetworkLabel, parseBillAmount, parseBillVerify, suggestedAmountText, validateBuyer,
  type StorefrontBiller, type StorefrontMeter,
} from "@/lib/storefront-commission/ui-helpers"

interface Props {
  shopSlug: string
  billers: StorefrontBiller[]
}

type Step = "input" | "meters" | "confirm"
interface Picked { token: string; name: string | null; account: string; due: number | null }

const labelCls = "mb-1.5 block text-sm font-bold text-foreground"
const fieldCls = "rounded-2xl border-border bg-card py-3.5"
const money = (n: number) => `GHS ${n.toFixed(2)}`
const UNCONFIRMED = "We could not confirm your order. Please check your connection and tap Pay again; you will not be charged twice."

export function BillsTab({ shopSlug, billers }: Props) {
  const [active, setActive] = useState<StorefrontBiller | null>(null)
  const list = billers.filter(b => (BILLER_KEYS as readonly string[]).includes(b.key))
  if (list.length === 0) return null
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {list.map(b => (
          <button
            key={b.key}
            type="button"
            onClick={() => setActive(b)}
            className="clay flex flex-col items-start gap-3 rounded-2xl border border-border bg-card p-4 text-left transition hover:border-[var(--shop-accent)]"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={b.logo} alt="" width={56} height={56} className="h-14 w-14 shrink-0 rounded-xl border border-border bg-white object-contain p-0.5" />
            <span>
              <span className="block text-sm font-bold text-foreground">{b.label}</span>
              <span className="block text-xs text-muted-foreground">{b.inputHint}</span>
            </span>
          </button>
        ))}
      </div>
      {active && <BillSheet key={active.key} shopSlug={shopSlug} biller={active} onClose={() => setActive(null)} />}
    </>
  )
}

function BillSheet({ shopSlug, biller, onClose }: { shopSlug: string; biller: StorefrontBiller; onClose: () => void }) {
  const key = biller.key
  const isEcg = key === "ecg"
  const isWater = key === "ghana_water"
  const isBroadband = key === "telecel_broadband"
  const needsPhone = isEcg || isWater

  const [step, setStep] = useState<Step>("input")
  const [account, setAccount] = useState("")
  const [phone, setPhone] = useState("")
  const [email, setEmail] = useState("")
  const [broadbandAccount, setBroadbandAccount] = useState("")
  const [consent, setConsent] = useState(false)
  const [addingMeter, setAddingMeter] = useState(false)
  const [ecgMode, setEcgMode] = useState<"phone" | "meter">("phone")
  const [meterType, setMeterType] = useState<"prepaid" | "postpaid">("prepaid")
  const meterNoun = meterType === "prepaid" ? "meter" : "postpaid account"
  const [meters, setMeters] = useState<StorefrontMeter[]>([])
  const [picked, setPicked] = useState<Picked | null>(null)
  const [amount, setAmount] = useState("")
  // After a 409 "price updated" the server's pay amount replaces the computed one for that face amount.
  const [serverPrice, setServerPrice] = useState<{ face: number; pay: number } | null>(null)

  const [buyerName, setBuyerName] = useState("")
  const [buyerEmail, setBuyerEmail] = useState("")
  const [buyerPhone, setBuyerPhone] = useState("")
  const [honeypot, setHoneypot] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const payingRef = useRef(false)
  const verifyingRef = useRef(false)

  const gate = useTurnstileGate()
  const otp = usePayerOtp(buyerPhone)
  const payment = useStorefrontPayment(shopSlug, "cs_bill", otp)

  const backToInput = (msg: string) => {
    setPicked(null)
    setAmount("")
    setServerPrice(null)
    setConsent(false)
    setStep(isEcg && ecgMode === "phone" && meters.length > 0 ? "meters" : "input")
    setError(msg)
  }

  const goToConfirm = (p: Picked, suggested: number) => {
    setServerPrice(null)
    setPicked(p)
    setAmount(suggestedAmountText(suggested))
    setError("")
    setStep("confirm")
  }

  const verify = async (opts: { addMeter?: boolean } = {}) => {
    if (verifyingRef.current) return
    if (gate.enabled && !gate.token) { setError("Please complete the security check."); return }
    verifyingRef.current = true
    setBusy(true)
    setError("")
    let status = 0
    let json: unknown = null
    try {
      const res = await fetch("/api/shop/bills/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopSlug,
          biller: key,
          phone: needsPhone ? phone : undefined,
          account: isEcg && !opts.addMeter ? undefined : account,
          email: isWater ? email : undefined,
          broadbandAccount: isBroadband ? broadbandAccount : undefined,
          addMeter: isEcg ? opts.addMeter === true : undefined,
          consent: isEcg && opts.addMeter ? consent : undefined,
          turnstileToken: gate.token,
          website: honeypot,
        }),
      })
      status = res.status
      json = await res.json().catch(() => null)
    } catch {
      status = 0
    }
    gate.renew() // single-use token
    verifyingRef.current = false
    setBusy(false)
    const r = status === 200
      ? parseBillVerify(json)
      : { ok: false as const, error: (json as { error?: string } | null)?.error || "Could not verify. Please try again." }
    if (!r.ok) { setError(r.error); return }
    if (isEcg && !opts.addMeter) {
      setMeters(r.meters)
      if (r.meters.length === 0) {
        setAddingMeter(true)
        setError("No meters are linked to this phone yet. Enter your meter number below; paying links it to this phone.")
      } else {
        setAddingMeter(false)
      }
      setStep("meters")
      return
    }
    if (!r.token) { setError("Could not verify. Please try again."); return }
    goToConfirm({ token: r.token, name: r.name, account, due: r.due }, r.suggested)
  }

  const face = parseBillAmount(amount, biller.min, biller.max)
  const computed = face !== null ? billStorefrontPrice(face, key, biller.terms) : null
  const forced = serverPrice && face !== null && serverPrice.face === face ? serverPrice.pay : null
  const pay = forced ?? computed?.pay ?? 0

  const submitPay = async (e: React.FormEvent) => {
    e.preventDefault()
    if (payingRef.current || !picked || face === null) return
    const buyerError = validateBuyer({ email: buyerEmail, phone: buyerPhone })
    if (buyerError) { setError(buyerError); return }
    if (payment.directCharge && !momoNetworkLabel(buyerPhone)) { setError(NOT_MOMO); return }
    if (otp.blocking) { setError("Please verify your phone number first."); return }
    if (gate.enabled && !gate.token) { setError("Please complete the security check."); return }
    payingRef.current = true
    setBusy(true)
    setError("")
    let status = 0
    let json: any = null
    try {
      const res = await fetch("/api/shop/bills/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopSlug,
          token: picked.token,
          amount: face,
          expectedPay: pay,
          customerName: buyerName.trim() || undefined,
          customerEmail: buyerEmail.trim(),
          customerPhone: buyerPhone.trim(),
          turnstileToken: gate.token,
          website: honeypot,
        }),
      })
      status = res.status
      json = await res.json().catch(() => null)
    } catch {
      status = 0
    }
    gate.renew()

    try {
      if (status === 200 && json?.orderId) {
        const payNow = typeof json.payAmount === "number" ? json.payAmount : pay
        // On-page MoMo charge when direct charge is on, else the hosted Paystack checkout; nothing about the product is sent.
        const r = await payment.pay({ orderId: json.orderId, amount: payNow, email: buyerEmail.trim(), paymentPhone: buyerPhone.trim() })
        if (r === "redirecting") return // keep the button busy while the browser navigates
        if (r === "otp_required") {
          otp.require()
          setError("Please verify your phone number to continue.")
        }
        // started / failed: the payment sheet shows the progress; tapping Pay again returns this same order.
      } else if (isOtpRequiredResponse(status, json)) {
        otp.require()
        setError("Please verify your phone number to continue.")
      } else {
        const change = parsePriceChange(status, json)
        if (change) {
          setServerPrice({ face, pay: change.payAmount })
          setError(`${change.message} The new price is ${money(change.payAmount)}. Tap Pay to continue.`)
        } else if (billNeedsReverify(status, json)) {
          backToInput(typeof json?.error === "string" ? json.error : "Please verify the account again.")
        } else if (status === 0 || status >= 500) {
          setError(UNCONFIRMED) // a retry returns the same order
        } else {
          setError(typeof json?.error === "string" && json.error ? json.error : "Something went wrong. Please try again.")
        }
      }
    } catch (err: any) {
      setError(err?.message || "Payment initialization failed")
    }
    payingRef.current = false
    setBusy(false)
  }

  const inputReady = isEcg
    ? ecgMode === "meter"
      ? account.trim().length >= 4 && phone.trim().length >= 9 && consent
      : phone.trim().length >= 9
    : isBroadband
      ? account.trim().length >= 4 && broadbandAccount.trim().length >= 3
      : isWater
        ? account.trim().length >= 4 && phone.trim().length >= 9 && email.trim().includes("@")
        : account.trim().length >= 4

  const verifyDisabled = !inputReady || busy || (gate.enabled && !gate.token)
  const close = () => { if (!busy) onClose() }
  const widget = gate.enabled ? (
    <div className="flex justify-center">
      <TurnstileWidget key={gate.nonce} onToken={gate.setToken} onExpire={() => gate.setToken("")} />
    </div>
  ) : null

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50" onClick={close}>
      <div
        className="flex max-h-[92dvh] w-full max-w-md flex-col rounded-t-3xl bg-card"
        onClick={e => e.stopPropagation()}
        onFocus={e => {
          const t = e.target as HTMLElement
          if (t.tagName === "INPUT") setTimeout(() => t.scrollIntoView({ block: "center", behavior: "smooth" }), 300)
        }}
      >
        <div className="relative flex shrink-0 justify-center pb-1 pt-3">
          <div className="h-1 w-10 rounded-full bg-border" />
          <button type="button" onClick={close} aria-label="Close" className="absolute right-4 top-2 grid h-8 w-8 place-items-center rounded-full bg-muted text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 pb-6 pt-2">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={biller.logo} alt="" width={48} height={48} className="h-12 w-12 shrink-0 rounded-xl border border-border bg-white object-contain p-0.5" />
            <div>
              <h3 className="text-lg font-bold text-foreground">{biller.label}</h3>
              <p className="text-xs text-muted-foreground">GHS {biller.min} to {biller.max}</p>
            </div>
          </div>

          {step === "input" && (
            <form onSubmit={e => { e.preventDefault(); if (!verifyDisabled) verify(isEcg && ecgMode === "meter" ? { addMeter: true } : {}) }} className="space-y-4">
              {isEcg ? (
                <>
                  <div className="grid grid-cols-2 gap-1 rounded-2xl bg-muted p-1" role="tablist" aria-label="Find your meter by">
                    {(["phone", "meter"] as const).map(m => (
                      <button
                        key={m}
                        type="button"
                        role="tab"
                        aria-selected={ecgMode === m}
                        onClick={() => { setEcgMode(m); setError(""); setConsent(false) }}
                        className={`rounded-xl py-2 text-xs font-bold transition ${ecgMode === m ? "bg-card text-[var(--shop-accent)] shadow-sm" : "text-muted-foreground"}`}
                      >
                        {m === "phone" ? "Phone number" : "Meter number"}
                      </button>
                    ))}
                  </div>
                  {ecgMode === "phone" ? (
                    <PhoneField value={phone} onChange={setPhone} hint="We look up the meters linked to this phone. Meter not linked yet? You can enter its number on the next step." />
                  ) : (
                    <>
                      <EcgMeterInput type={meterType} onType={t => { setMeterType(t); setConsent(false) }} value={account} onChange={v => { setAccount(v); setConsent(false) }} />
                      <PhoneField value={phone} onChange={v => { setPhone(v); setConsent(false) }} hint="ECG top-ups go through a phone number. If this meter isn't linked to it yet, paying links it." />
                      <label className="flex items-start gap-2 text-xs text-muted-foreground">
                        <input type="checkbox" className="mt-0.5" checked={consent} onChange={e => setConsent(e.target.checked)} />
                        <span>This links {meterNoun} {account.trim() || "-"} to phone {phone.trim() || "-"} with ECG</span>
                      </label>
                    </>
                  )}
                </>
              ) : isBroadband ? (
                <>
                  <div>
                    <label className={labelCls}>Landline number</label>
                    <Input className={fieldCls} inputMode="numeric" placeholder="0302450262" value={account} onChange={e => setAccount(e.target.value)} />
                  </div>
                  <div>
                    <label className={labelCls}>Broadband account number</label>
                    <Input className={fieldCls} placeholder="P0444101" value={broadbandAccount} onChange={e => setBroadbandAccount(e.target.value)} />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className={labelCls}>{biller.inputHint}</label>
                    <Input className={fieldCls} placeholder={biller.inputHint} value={account} onChange={e => setAccount(e.target.value)} />
                  </div>
                  {isWater && (
                    <>
                      <PhoneField value={phone} onChange={setPhone} hint="Ghana Water needs a phone number to verify the meter." />
                      <div>
                        <label className={labelCls}>Email</label>
                        <Input className={fieldCls} type="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} />
                      </div>
                    </>
                  )}
                </>
              )}
              <HoneypotField value={honeypot} onChange={setHoneypot} />
              {widget}
              <ErrorLine msg={error} />
              <Button type="submit" disabled={verifyDisabled} className="w-full rounded-2xl bg-[var(--shop-accent)] py-4 text-base font-bold text-white hover:bg-[var(--shop-accent)]/90">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <>{isEcg ? (ecgMode === "meter" ? "Verify meter" : "Find my meters") : "Verify account"} <ArrowRight className="ml-2 h-4 w-4" /></>}
              </Button>
            </form>
          )}

          {step === "meters" && (
            <div className="space-y-3">
              {meters.length > 0 && <p className="text-sm font-bold text-foreground">Select a meter</p>}
              {meters.map(m => (
                <button
                  key={m.meter}
                  type="button"
                  disabled={busy}
                  onClick={() => goToConfirm({ token: m.token, name: m.name, account: m.meter, due: m.outstanding }, m.outstanding && m.outstanding > 0 ? m.outstanding : 0)}
                  className="clay-sm flex w-full items-center justify-between gap-3 rounded-2xl border border-border bg-background p-4 text-left disabled:opacity-50"
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
                <button type="button" onClick={() => { setAddingMeter(true); setError("") }} className="w-full rounded-2xl border border-dashed border-border py-3 text-sm font-semibold text-[var(--shop-accent)]">
                  + Add another meter
                </button>
              ) : (
                <form onSubmit={e => { e.preventDefault(); if (account.trim().length >= 4 && consent && !busy && !(gate.enabled && !gate.token)) verify({ addMeter: true }) }} className="space-y-3 rounded-2xl border border-border p-4">
                  <EcgMeterInput type={meterType} onType={t => { setMeterType(t); setConsent(false) }} value={account} onChange={v => { setAccount(v); setConsent(false) }} />
                  <label className="flex items-start gap-2 text-xs text-muted-foreground">
                    <input type="checkbox" className="mt-0.5" checked={consent} onChange={e => setConsent(e.target.checked)} />
                    <span>This links {meterNoun} {account.trim() || "-"} to phone {phone} with ECG</span>
                  </label>
                  {widget}
                  <Button type="submit" disabled={account.trim().length < 4 || !consent || busy || (gate.enabled && !gate.token)} className="w-full rounded-2xl bg-[var(--shop-accent)] py-3.5 text-sm font-bold text-white hover:bg-[var(--shop-accent)]/90">
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Verify meter <ArrowRight className="ml-2 h-4 w-4" /></>}
                  </Button>
                </form>
              )}
              <ErrorLine msg={error} />
              <button type="button" onClick={() => { setStep("input"); setError("") }} className="w-full text-xs font-medium text-muted-foreground">Use a different phone number</button>
            </div>
          )}

          {step === "confirm" && picked && (
            <form onSubmit={submitPay} className="space-y-4">
              <div className="clay-sm space-y-2 rounded-2xl border border-border bg-background p-4">
                <Row k="Customer" v={picked.name || "Unverified, entered manually"} />
                <Row k="Account" v={isBroadband ? `${picked.account} / ${broadbandAccount}` : picked.account} mono />
                {picked.due !== null && picked.due > 0 && <Row k="Amount due" v={money(picked.due)} />}
              </div>

              <div>
                <div className="mb-1.5 flex items-baseline justify-between">
                  <label className="text-sm font-bold text-foreground">Amount (GHS)</label>
                  <span className="text-xs text-muted-foreground">Min {biller.min} / Max {biller.max}</span>
                </div>
                <Input className={`${fieldCls} text-lg font-semibold`} type="number" inputMode="decimal" min={biller.min} max={biller.max} step="0.01" placeholder="0.00" value={amount} onChange={e => { setAmount(e.target.value); setServerPrice(null) }} />
                {amount !== "" && face === null && <p className="mt-1 text-xs text-destructive">Amount must be between GHS {biller.min} and GHS {biller.max}.</p>}
              </div>

              <div>
                <label className={labelCls}>Your name</label>
                <Input className={fieldCls} placeholder="E.g John Doe" value={buyerName} onChange={e => setBuyerName(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>Your email *</label>
                <Input className={fieldCls} type="email" required placeholder="john@example.com" value={buyerEmail} onChange={e => setBuyerEmail(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>{payment.directCharge ? "Your Mobile Money number *" : "Your phone *"}</label>
                <Input className={`${fieldCls} font-mono`} type="tel" inputMode="numeric" required placeholder="024XXXXXXX" value={buyerPhone} onChange={e => setBuyerPhone(e.target.value)} />
                {payment.directCharge && <div className="mt-1.5"><MomoPayerHint phone={buyerPhone} /></div>}
              </div>

              {face !== null && computed && (
                <div className="clay-sm space-y-3 rounded-2xl border border-border bg-background p-4">
                  {(computed.customerCashback > 0 || computed.paymentFee > 0) && (
                    <div className="space-y-1">
                      <Row k="Bill amount" v={money(face)} />
                      {computed.customerCashback > 0 && <Row k="Discount" v={`- ${money(computed.customerCashback)}`} />}
                      {computed.paymentFee > 0 && <Row k="Payment fee" v={`+ ${money(computed.paymentFee)}`} />}
                    </div>
                  )}
                  <PriceSummary pay={pay} receive={billReceiveLabel(biller.label, face, picked.account)} balance={null} />
                </div>
              )}

              <PayerOtpStep otp={otp} />
              <HoneypotField value={honeypot} onChange={setHoneypot} />
              {widget}
              <ErrorLine msg={error} />
              <Button type="submit" disabled={busy || face === null || otp.blocking || (gate.enabled && !gate.token)} className="w-full rounded-2xl bg-[var(--shop-accent)] py-4 text-base font-bold text-white hover:bg-[var(--shop-accent)]/90">
                {busy ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />Processing...</>) : `Pay ${face !== null ? money(pay) : "GHS 0.00"}`}
              </Button>
              <button type="button" onClick={() => { setStep(isEcg && ecgMode === "phone" ? "meters" : "input"); setError("") }} disabled={busy} className="w-full text-xs font-medium text-muted-foreground">Back</button>
            </form>
          )}
        </div>
      </div>
      {/* Inside the bill sheet's backdrop: keep the payment sheet's clicks from closing the bill sheet. */}
      {payment.sheet && <div onClick={e => e.stopPropagation()}>{payment.sheet}</div>}
    </div>
  )
}

function PhoneField({ value, onChange, hint }: { value: string; onChange: (v: string) => void; hint: string }) {
  return (
    <div>
      <label className={labelCls}>Phone number</label>
      <div className="relative">
        <Phone className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input className={`${fieldCls} pl-11 font-mono`} type="tel" inputMode="tel" placeholder="024XXXXXXX" value={value} onChange={e => onChange(e.target.value)} />
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{k}</span>
      <span className={`text-right font-semibold text-foreground ${mono ? "font-mono text-xs" : ""}`}>{v}</span>
    </div>
  )
}

function ErrorLine({ msg }: { msg: string }) {
  if (!msg) return null
  return <p role="alert" className="rounded-xl bg-destructive/10 px-4 py-2.5 text-sm font-medium text-destructive">{msg}</p>
}
