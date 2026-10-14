"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import TurnstileWidget from "@/components/shop/TurnstileWidget"
import HoneypotField from "@/components/shop/HoneypotField"
import { PriceSummary } from "@/components/cashback/PriceSummary"
import { bundleReceiveLabel, parsePriceChange } from "@/lib/cashback/display"
import { normalizeGhanaPhone } from "@/lib/phone-format"
import {
  BUNDLE_UNCONFIRMED_MESSAGE, isCatalogStale, keyAfterPhoneEdit, parsePrefixRules, recipientIdentity, shouldRotateIdempotencyKey,
  validateBundleRecipient, type PrefixRules,
} from "@/lib/standard-bundles/ui-helpers"
import { newUuid } from "@/lib/standard-bundles/uuid"
import {
  bundlePriceParts, parseStorefrontCatalog, validateBuyer, type StorefrontBundle, type StorefrontCategory,
} from "@/lib/storefront-commission/ui-helpers"

interface Props {
  shopSlug: string
  networks: { network: string; label: string }[]
}

type Catalog = { fetchedAt: number; categories: StorefrontCategory[] }

export function BundlesTab({ shopSlug, networks }: Props) {
  const [network, setNetwork] = useState<string>(networks[0]?.network ?? "")
  const [catalogs, setCatalogs] = useState<Record<string, Catalog>>({})
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [category, setCategory] = useState<string | null>(null)

  const [selected, setSelected] = useState<StorefrontBundle | null>(null)
  const [recipient, setRecipient] = useState("")
  const [buyerName, setBuyerName] = useState("")
  const [buyerEmail, setBuyerEmail] = useState("")
  const [buyerPhone, setBuyerPhone] = useState("")
  const [idemKey, setIdemKey] = useState("")
  const lastAttempt = useRef<{ recipient: string; key: string } | null>(null)
  // After a 409 "price updated" the server's price replaces the card price until the customer taps again.
  const [priceOverride, setPriceOverride] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [turnstileEnabled, setTurnstileEnabled] = useState(true)
  const [turnstileToken, setTurnstileToken] = useState("")
  const [turnstileNonce, setTurnstileNonce] = useState(0)
  const [honeypot, setHoneypot] = useState("")
  const [prefixRules, setPrefixRules] = useState<PrefixRules | null>(null)

  useEffect(() => {
    fetch("/api/public/turnstile-status")
      .then(r => (r.ok ? r.json() : { enabled: true }))
      .then(d => setTurnstileEnabled(d.enabled !== false))
      .catch(() => setTurnstileEnabled(true))
    fetch("/api/network-prefixes")
      .then(r => (r.ok ? r.json() : null))
      .then(j => setPrefixRules(parsePrefixRules(j)))
      .catch(() => setPrefixRules(null))
  }, [])

  const loadCatalog = useCallback(async (net: string, force = false): Promise<StorefrontCategory[]> => {
    const cached = catalogs[net]
    if (!force && cached && !isCatalogStale(cached.fetchedAt, Date.now())) return cached.categories
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch(`/api/shop/bundles/catalog?shop=${encodeURIComponent(shopSlug)}&network=${encodeURIComponent(net)}`)
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(typeof json?.error === "string" ? json.error : "Could not load bundles")
      const categories = parseStorefrontCatalog(json)
      setCatalogs(prev => ({ ...prev, [net]: { fetchedAt: Date.now(), categories } }))
      return categories
    } catch (e: any) {
      setLoadError(e?.message || "Could not load bundles")
      return []
    } finally {
      setLoading(false)
    }
  }, [catalogs, shopSlug])

  useEffect(() => {
    if (!network) return
    setCategory(null)
    loadCatalog(network)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network])

  const categories = catalogs[network]?.categories ?? []
  const activeCategory = categories.find(c => c.name === category) ?? categories[0]

  const openSheet = async (b: StorefrontBundle) => {
    // Catalog tokens expire after 10 minutes: re-fetch when stale and pick the same bundle from the fresh list.
    let bundle = b
    const cached = catalogs[network]
    if (!cached || isCatalogStale(cached.fetchedAt, Date.now())) {
      const fresh = await loadCatalog(network, true)
      const same = fresh.flatMap(c => c.bundles).find(x => x.value === b.value && x.category === b.category && Math.round(x.amount * 100) === Math.round(b.amount * 100))
      if (!same) { toast.error("That bundle changed. Please pick it again."); return }
      bundle = same
    }
    setSelected(bundle)
    setPriceOverride(null)
    setFormError(null)
    setIdemKey(newUuid())
    lastAttempt.current = null
    setTurnstileToken("")
    setTurnstileNonce(n => n + 1)
  }

  const closeSheet = () => { if (!submitting) setSelected(null) }

  const rotateKey = () => { setIdemKey(newUuid()); lastAttempt.current = null }

  const onRecipientChange = (next: string) => {
    setIdemKey(k => keyAfterPhoneEdit({ prevPhone: recipient, nextPhone: next, currentKey: k, lastAttempt: lastAttempt.current, newKey: newUuid }))
    setRecipient(next)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selected || submitting) return
    const recipientError = validateBundleRecipient(network, recipient, prefixRules)
    if (recipientError) { setFormError(recipientError); return }
    const buyerError = validateBuyer({ email: buyerEmail, phone: buyerPhone })
    if (buyerError) { setFormError(buyerError); return }
    if (turnstileEnabled && !turnstileToken) { setFormError("Please complete the security check."); return }

    setFormError(null)
    setSubmitting(true)
    const expectedPay = priceOverride ?? selected.payAmount
    const recipientNormalized = normalizeGhanaPhone(recipient.trim()) || recipient.trim()
    lastAttempt.current = { recipient: recipientIdentity(recipient), key: idemKey }
    let httpStatus: number | null = null
    let json: any = null
    try {
      const res = await fetch("/api/shop/bundles/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopSlug,
          token: selected.token,
          phone: recipientNormalized,
          idempotencyKey: idemKey,
          expectedPay,
          customerName: buyerName.trim() || undefined,
          customerEmail: buyerEmail.trim(),
          customerPhone: buyerPhone.trim(),
          turnstileToken,
          website: honeypot,
        }),
      })
      httpStatus = res.status
      json = await res.json().catch(() => null)
    } catch {
      httpStatus = null
    }
    // Turnstile tokens are single-use: always get a fresh one for the next attempt.
    setTurnstileToken("")
    setTurnstileNonce(n => n + 1)

    try {
      if (httpStatus === 200 && json?.orderId) {
        const pay = typeof json.payAmount === "number" ? json.payAmount : expectedPay
        // Same hosted-Paystack initiation as storefront airtime; nothing about the product is sent.
        const payRes = await fetch("/api/payments/initialize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount: pay, email: buyerEmail.trim(), orderId: json.orderId, orderType: "cs_bundle", shopSlug }),
        })
        const payJson = await payRes.json().catch(() => null)
        if (!payRes.ok) throw new Error(payJson?.error || "Payment initialization failed")
        if (!payJson?.authorizationUrl) throw new Error("No payment URL received")
        window.location.href = payJson.authorizationUrl
        return // keep the button busy while the browser navigates
      }

      const change = httpStatus === null ? null : parsePriceChange(httpStatus, json)
      if (change) {
        setPriceOverride(change.payAmount)
        setFormError(`${change.message} The new price is GHS ${change.payAmount.toFixed(2)}. Tap Pay to continue.`)
        rotateKey()
      } else if (httpStatus === 409) {
        setFormError(typeof json?.error === "string" ? json.error : "Prices refreshed. Please pick the bundle again.")
        setSelected(null)
        loadCatalog(network, true)
      } else if (httpStatus === null || httpStatus === 0 || httpStatus >= 500) {
        // Uncertain: keep the key so a retry dedupes server-side.
        setFormError(BUNDLE_UNCONFIRMED_MESSAGE)
      } else {
        if (shouldRotateIdempotencyKey(httpStatus, json)) rotateKey()
        setFormError(typeof json?.error === "string" && json.error ? json.error : "Something went wrong. Please try again.")
      }
    } catch (err: any) {
      // The order exists but is unpaid; the same key resumes it on retry.
      setFormError(err?.message || "Payment initialization failed")
    }
    setSubmitting(false)
  }

  if (networks.length === 0) return null

  const pay = selected ? priceOverride ?? selected.payAmount : 0
  const was = selected ? bundlePriceParts({ amount: selected.amount, payAmount: pay }).was : null

  return (
    <div className="space-y-5">
      <div className="flex gap-2 overflow-x-auto [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: "none" }}>
        {networks.map(n => (
          <button
            key={n.network}
            type="button"
            onClick={() => setNetwork(n.network)}
            className={`shrink-0 rounded-full border px-5 py-2 text-sm font-bold transition ${
              network === n.network ? "border-[var(--shop-accent)] bg-[var(--shop-accent)] text-white" : "border-border bg-card text-foreground hover:border-[var(--shop-accent)]/30"
            }`}
          >
            {n.label}
          </button>
        ))}
      </div>

      {loading && categories.length === 0 ? (
        <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : loadError && categories.length === 0 ? (
        <div className="space-y-3 rounded-2xl border border-border bg-card p-6 text-center">
          <p className="text-sm text-muted-foreground">{loadError}</p>
          <Button type="button" variant="outline" className="rounded-2xl" onClick={() => loadCatalog(network, true)}>Try again</Button>
        </div>
      ) : categories.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">Nothing available right now.</p>
      ) : (
        <>
          <div className="flex gap-1.5 overflow-x-auto rounded-2xl bg-muted/60 p-1.5 [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: "none" }}>
            {categories.map(c => {
              const on = c.name === activeCategory?.name
              return (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => setCategory(c.name)}
                  className={`shrink-0 rounded-full px-4 py-2 text-sm font-bold transition-colors ${on ? "bg-card text-[var(--shop-accent)] shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {c.name}
                </button>
              )
            })}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {activeCategory?.bundles.map(b => {
              const p = bundlePriceParts(b)
              return (
                <button
                  key={`${b.category}|${b.value}|${b.amount}`}
                  type="button"
                  onClick={() => openSheet(b)}
                  className="flex flex-col items-center gap-1 rounded-2xl border border-border bg-card p-4 text-center transition hover:border-[var(--shop-accent)] clay"
                >
                  <span className="text-lg font-extrabold text-foreground">{b.display}</span>
                  <span className="text-sm font-bold text-[var(--shop-accent)]">{p.now}</span>
                  {p.was && <span className="text-xs text-muted-foreground">{p.was}</span>}
                </button>
              )
            })}
          </div>
        </>
      )}

      {selected && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50" onClick={closeSheet}>
          <form
            onSubmit={submit}
            className="flex max-h-[92dvh] w-full max-w-md flex-col rounded-t-3xl bg-card"
            onClick={e => e.stopPropagation()}
            onFocus={e => {
              const t = e.target as HTMLElement
              if (t.tagName === "INPUT") setTimeout(() => t.scrollIntoView({ block: "center", behavior: "smooth" }), 300)
            }}
          >
            <div className="relative flex shrink-0 justify-center pb-1 pt-3">
              <div className="h-1 w-10 rounded-full bg-border" />
              <button type="button" onClick={closeSheet} aria-label="Close" className="absolute right-4 top-2 grid h-8 w-8 place-items-center rounded-full bg-muted text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 overflow-y-auto px-5 pb-6 pt-2">
              <div>
                <h3 className="text-lg font-bold text-foreground">{selected.display}</h3>
                <p className="text-sm text-muted-foreground">
                  {selected.category}
                  {was && <span> · {was}</span>}
                </p>
              </div>

              <div className="space-y-1.5">
                <p className="text-sm font-bold text-foreground">Recipient number *</p>
                <Input type="tel" inputMode="numeric" required placeholder="024XXXXXXX" className="rounded-2xl border-border bg-card py-3.5 font-mono" value={recipient} onChange={e => onRecipientChange(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-bold text-foreground">Your name</p>
                <Input placeholder="E.g John Doe" className="rounded-2xl border-border bg-card py-3.5" value={buyerName} onChange={e => setBuyerName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-bold text-foreground">Your email *</p>
                <Input type="email" required placeholder="john@example.com" className="rounded-2xl border-border bg-card py-3.5" value={buyerEmail} onChange={e => setBuyerEmail(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-bold text-foreground">Your phone *</p>
                <Input type="tel" inputMode="numeric" required placeholder="024XXXXXXX" className="rounded-2xl border-border bg-card py-3.5 font-mono" value={buyerPhone} onChange={e => setBuyerPhone(e.target.value)} />
              </div>

              <div className="rounded-2xl border border-border bg-card p-4">
                <PriceSummary pay={pay} receive={bundleReceiveLabel(selected.category, selected.display)} balance={null} />
              </div>

              <HoneypotField value={honeypot} onChange={setHoneypot} />

              {turnstileEnabled && (
                <div className="flex justify-center">
                  <TurnstileWidget key={turnstileNonce} onToken={setTurnstileToken} onExpire={() => setTurnstileToken("")} />
                </div>
              )}

              {formError && <p className="rounded-xl bg-destructive/10 px-4 py-2.5 text-sm font-medium text-destructive">{formError}</p>}

              <Button
                type="submit"
                disabled={submitting || (turnstileEnabled && !turnstileToken)}
                className="w-full rounded-2xl bg-[var(--shop-accent)] py-4 text-base font-bold text-white hover:bg-[var(--shop-accent)]/90"
              >
                {submitting ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />Processing...</>) : `Pay GHS ${pay.toFixed(2)}`}
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
