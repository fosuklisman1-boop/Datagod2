"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { DashboardHeroBanner } from "@/components/shared/dashboard-hero-banner"
import { supabase } from "@/lib/supabase"
import { Phone, CheckCircle2, Circle, RefreshCw, ArrowRight, Clock, History as HistoryIcon } from "lucide-react"
import { PurchaseSheet, type PurchaseSheetModal } from "@/components/dashboard/PurchaseSheet"

const NETWORKS = ["MTN", "Telecel", "AT"]
// AT/AirtelTigo gets a literal orange here (its own real brand color, and
// this reference's chosen color for it) rather than reusing bg-at, which
// elsewhere in this app means "AT - iShare" specifically (a different,
// blue-branded product line on the data side).
const NETWORK_META: Record<string, { label: string; className: string; border: string }> = {
  MTN: { label: "MTN", className: "bg-mtn text-mtn-foreground", border: "border-mtn" },
  Telecel: { label: "Telecel", className: "bg-telecel text-telecel-foreground", border: "border-telecel" },
  AT: { label: "AirtelTigo", className: "bg-[#F0752B] text-white", border: "border-[#F0752B]" },
}
const NETWORK_PREFIXES: Record<string, string[]> = {
  MTN:     ["024", "054", "055", "059", "025"],
  Telecel: ["050", "020"],
  AT:      ["027", "057", "026", "028"],
}
const QUICK_AMOUNTS = [1, 2, 5, 10, 20, 50]

function detectNetworkFromPhone(phone: string): string | null {
  const prefix = phone.substring(0, 3)
  for (const [net, prefixes] of Object.entries(NETWORK_PREFIXES)) {
    if (prefixes.includes(prefix)) return net
  }
  return null
}

interface AirtimeOrder {
  id: string
  reference_code: string
  network: string
  beneficiary_phone: string
  airtime_amount: number
  fee_amount: number
  total_paid: number
  status: string
  created_at: string
}

const STATUS_CLASSES: Record<string, string> = {
  pending:    "bg-warning/10 text-warning",
  processing: "bg-[#1b388b]/10 text-[#1b388b]",
  completed:  "bg-success/15 text-success",
  failed:     "bg-destructive/15 text-destructive",
}

export default function AirtimePage() {
  const router = useRouter()
  const [tab, setTab] = useState<"buy" | "history">("buy")

  // Form state
  const [network, setNetwork]           = useState("MTN")
  const [phone, setPhone]               = useState("")
  const [amount, setAmount]             = useState("")
  const [paySeparately, setPaySeparately] = useState(true)

  // Derived / settings
  const [feeRate, setFeeRate]           = useState(5)
  const [minAmount, setMinAmount]       = useState(1)
  const [maxAmount, setMaxAmount]       = useState(500)
  const [userRole, setUserRole]         = useState("user")
  const [walletBalance, setWalletBalance] = useState<number | null>(null)
  const [phoneError, setPhoneError]     = useState("")
  const [settingsLoading, setSettingsLoading] = useState(false)

  // Orders
  const [orders, setOrders]             = useState<AirtimeOrder[]>([])
  const [loadingOrders, setLoadingOrders] = useState(true)

  // Submission
  const [submitting, setSubmitting]     = useState(false)
  const [purchaseModal, setPurchaseModal] = useState<PurchaseSheetModal | null>(null)
  // Guards the in-flight purchase call from reopening a stale success/failed
  // view after the customer already dismissed the sheet themselves.
  const purchaseDismissedRef = useRef(false)

  // ----- Fee calculations -----
  const numAmount = parseFloat(amount) || 0
  const feeAmount = paySeparately
    ? parseFloat((numAmount * feeRate / 100).toFixed(2))
    : parseFloat((numAmount * feeRate / (100 + feeRate)).toFixed(2))
  const totalPaid = paySeparately
    ? parseFloat((numAmount + feeAmount).toFixed(2))
    : numAmount
  const airtimeToRecipient = paySeparately
    ? numAmount
    : parseFloat((numAmount - feeAmount).toFixed(2))

  const amountOutOfRange = numAmount > 0 && (numAmount < minAmount || numAmount > maxAmount)

  const [availableNetworks, setAvailableNetworks] = useState<string[]>(["MTN", "Telecel", "AT"])

  // ----- Load wallet balance & fee/limit settings -----
  const loadSettings = useCallback(async () => {
    setSettingsLoading(true)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push("/auth/login"); return }

    const [walletRes, roleRes] = await Promise.all([
      supabase.from("wallets").select("balance").eq("user_id", session.user.id).single(),
      supabase.from("users").select("role").eq("id", session.user.id).single(),
    ])
    setWalletBalance(walletRes.data?.balance ?? 0)
    const role = roleRes.data?.role || "user"
    setUserRole(role)
    const isDealer = role === "dealer" || role === "sub_agent"

    // Fetch availability/fee/limit settings via curated public-config
    // (admin_settings is service-role only). Same real airtime_min_amount /
    // airtime_max_amount the USSD/WhatsApp/AI purchase flows already read
    // via lib/airtime-pricing.ts -- this page previously had no min/max UI
    // at all, so those numbers were invisible here.
    let airtimeSettings: Record<string, any> = {}
    try {
      const res = await fetch("/api/public/config")
      if (res.ok) {
        const cfg = await res.json()
        airtimeSettings = cfg.admin_settings ?? {}
      }
    } catch (e) {
      console.warn("Could not load airtime config:", e)
    } finally {
      setSettingsLoading(false)
    }

    const enabledNets = ["MTN", "Telecel", "AT"].filter(n => {
      const setting = airtimeSettings[`airtime_enabled_${n.toLowerCase()}`]
      return setting?.enabled !== false
    })
    setAvailableNetworks(enabledNets)
    if (enabledNets.length > 0 && !enabledNets.includes(network)) {
      setNetwork(enabledNets[0])
    }

    const netKey = network.toLowerCase()
    const feeSetting = airtimeSettings[`airtime_fee_${netKey}_${isDealer ? 'dealer' : 'customer'}`]
    setFeeRate(feeSetting?.rate ?? 5)
    setMinAmount(airtimeSettings["airtime_min_amount"]?.amount ?? 1)
    setMaxAmount(airtimeSettings["airtime_max_amount"]?.amount ?? 500)
  }, [network, router])

  const loadOrders = useCallback(async () => {
    setLoadingOrders(true)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return
    const { data } = await supabase
      .from("airtime_orders")
      .select("*")
      .eq("user_id", session.user.id)
      .order("created_at", { ascending: false })
      .limit(20)
    setOrders(data || [])
    setLoadingOrders(false)
  }, [])

  useEffect(() => { loadSettings(); loadOrders() }, [loadSettings, loadOrders])
  useEffect(() => { loadSettings() }, [network])

  const handlePhoneChange = (val: string) => {
    setPhone(val)
    setPhoneError("")
    if (val.length === 10) {
      const detected = detectNetworkFromPhone(val)
      if (detected && detected !== network) {
        setPhoneError(`This number appears to be a ${detected} number. You selected ${network}.`)
      } else if (!detected) {
        setPhoneError("Unrecognised network prefix.")
      }
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (phoneError || amountOutOfRange) return
    setSubmitting(true)
    purchaseDismissedRef.current = false
    setPurchaseModal({ state: "processing" })
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push("/auth/login"); return }

      const res = await fetch("/api/airtime/purchase", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ network, beneficiaryPhone: phone, airtimeAmount: numAmount, paySeparately }),
      })
      const data = await res.json()
      if (!res.ok) {
        if (!purchaseDismissedRef.current) setPurchaseModal({ state: "failed", message: data.error || "Purchase failed" })
      } else {
        // Customer already dismissed the sheet before this resolved -- the
        // order still went through, but don't reopen a view they already closed.
        if (purchaseDismissedRef.current) return
        setPurchaseModal({
          state: "success",
          summary: { reference: data.order.reference_code, network, phone, amount: totalPaid },
        })
        setPhone("")
        setAmount("")
        setWalletBalance(data.newBalance)
        loadOrders()
      }
    } catch {
      if (!purchaseDismissedRef.current) setPurchaseModal({ state: "failed", message: "Something went wrong. Please try again." })
    } finally {
      setSubmitting(false)
    }
  }

  const handleCancelPurchase = () => { purchaseDismissedRef.current = true; setPurchaseModal(null) }
  const handleDismissPurchase = () => { purchaseDismissedRef.current = true; setPurchaseModal(null) }

  return (
    <DashboardLayout>
      <div className="max-w-2xl lg:max-w-4xl mx-auto space-y-5">
        <DashboardHeroBanner title="Buy Airtime" subtitle="Top up any network instantly, for yourself or someone else." icon={Phone}>
          <div className="rounded-full border border-white/25 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white">
            Balance: GHS {walletBalance !== null ? Math.max(0, walletBalance).toFixed(2) : "…"}
          </div>
        </DashboardHeroBanner>

        {/* Tabs */}
        <div className="inline-flex w-full rounded-2xl bg-muted p-1">
          <button
            onClick={() => setTab("buy")}
            className={`flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold transition ${tab === "buy" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
          >
            <Phone className="h-4 w-4" /> Buy airtime
          </button>
          <button
            onClick={() => setTab("history")}
            className={`flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold transition ${tab === "history" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
          >
            <HistoryIcon className="h-4 w-4" /> History
          </button>
        </div>

        {tab === "buy" ? (
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Network */}
            <div className="space-y-2">
              <p className="text-sm font-bold text-foreground">Network</p>
              <div className="grid grid-cols-3 gap-2 sm:gap-3">
                {NETWORKS.map((n) => {
                  const meta = NETWORK_META[n]
                  const isSelected = network === n
                  const isAvailable = availableNetworks.includes(n)
                  return (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setNetwork(n)}
                      disabled={!isAvailable}
                      className={`flex flex-col items-center gap-2 rounded-2xl border-2 bg-card p-3 sm:p-4 transition disabled:opacity-40 ${
                        isSelected ? `${meta.border} shadow-sm` : "border-border hover:border-[#1b388b]/30"
                      }`}
                    >
                      <span className={`flex h-10 w-10 items-center justify-center rounded-full text-xs font-extrabold ${meta.className}`}>
                        {n === "AT" ? "AT" : n.slice(0, 3).toUpperCase()}
                      </span>
                      <span className="text-xs sm:text-sm font-bold text-foreground">{meta.label}</span>
                    </button>
                  )
                })}
              </div>
              {availableNetworks.length === 0 && !settingsLoading && (
                <div className="bg-destructive/10 text-destructive p-4 rounded-xl border border-border text-center font-medium text-sm">
                  Airtime services are temporarily unavailable. Please check back later.
                </div>
              )}
            </div>

            {/* Phone */}
            <div className="space-y-2">
              <p className="text-sm font-bold text-foreground">Beneficiary phone number</p>
              <div className="relative">
                <Phone className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="tel"
                  inputMode="numeric"
                  maxLength={10}
                  value={phone}
                  onChange={(e) => handlePhoneChange(e.target.value.replace(/\D/g, ""))}
                  placeholder="0XXXXXXXXX"
                  required
                  className="w-full rounded-2xl border border-border bg-card py-3.5 pl-11 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#1b388b]"
                />
              </div>
              {phoneError && <p className="text-xs text-warning">{phoneError}</p>}
            </div>

            {/* Quick amount */}
            <div className="space-y-2">
              <p className="text-sm font-bold text-foreground">Quick amount (GHS)</p>
              <div className="flex flex-wrap items-center gap-2">
                {QUICK_AMOUNTS.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setAmount(String(v))}
                    className={`rounded-full border px-4 py-2 text-sm font-bold transition ${
                      amount === String(v) ? "border-[#1b388b] bg-[#1b388b] text-primary-foreground" : "border-border bg-card text-foreground hover:border-[#1b388b]/30"
                    }`}
                  >
                    {v}
                  </button>
                ))}
                <button
                  type="button"
                  aria-label="Reload settings"
                  onClick={loadSettings}
                  disabled={settingsLoading}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-sm disabled:opacity-50"
                >
                  <RefreshCw className={`h-4 w-4 ${settingsLoading ? "animate-spin" : ""}`} />
                </button>
              </div>
            </div>

            {/* Custom amount */}
            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <p className="text-sm font-bold text-foreground">Custom amount (GHS)</p>
                <p className="text-xs text-muted-foreground">Min {minAmount} · Max {maxAmount}</p>
              </div>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm font-semibold text-muted-foreground">GHS</span>
                <input
                  type="number"
                  min={minAmount}
                  max={maxAmount}
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  required
                  className="w-full rounded-2xl border border-border bg-card py-3.5 pl-14 pr-4 text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-[#1b388b]"
                />
              </div>
              {amountOutOfRange && (
                <p className="text-xs text-destructive">Amount must be between GHS {minAmount} and GHS {maxAmount}.</p>
              )}
            </div>

            {/* Pay fee separately -- real toggle, real different fee math */}
            <button
              type="button"
              onClick={() => setPaySeparately(!paySeparately)}
              className={`flex w-full items-start gap-3 rounded-2xl border p-4 text-left transition ${
                paySeparately ? "border-[#75beab]/40 bg-[#e9f4f1]" : "border-border bg-card"
              }`}
            >
              {paySeparately ? (
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[#0f7a4d]" />
              ) : (
                <Circle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
              )}
              <span>
                <span className={`block text-sm font-bold ${paySeparately ? "text-[#0f7a4d]" : "text-foreground"}`}>
                  Pay processing fee separately
                </span>
                <span className={`mt-0.5 block text-xs ${paySeparately ? "text-[#0f7a4d]/80" : "text-muted-foreground"}`}>
                  {paySeparately
                    ? "Beneficiary receives exactly the amount you type. The service fee is added to your total."
                    : "The service fee is deducted from the amount you type before it's delivered."}
                </span>
              </span>
            </button>

            {/* Fee breakdown */}
            {numAmount > 0 && (
              <div className="rounded-2xl border border-border bg-card p-4 space-y-2 text-sm">
                <div className="flex justify-between text-muted-foreground">
                  <span>Recipient gets</span>
                  <span className="font-semibold text-foreground">GHS {airtimeToRecipient.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-muted-foreground">
                  <span>Service fee ({feeRate}%{(userRole === 'dealer' || userRole === 'sub_agent') ? ", dealer rate" : ""})</span>
                  <span>GHS {feeAmount.toFixed(2)}</span>
                </div>
                <div className="flex justify-between border-t border-border pt-2 font-bold text-foreground">
                  <span>You pay</span>
                  <span>GHS {totalPaid.toFixed(2)}</span>
                </div>
                {walletBalance !== null && totalPaid > walletBalance && (
                  <p className="text-xs font-medium text-destructive">⚠ Insufficient wallet balance</p>
                )}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || !!phoneError || !phone || !amount || amountOutOfRange || (walletBalance !== null && totalPaid > walletBalance)}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#16A34A] py-4 text-base font-bold text-white transition hover:bg-[#15803d] disabled:opacity-50"
            >
              {submitting ? "Processing…" : (
                <>
                  Proceed to payment <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
          </form>
        ) : (
          <div className="space-y-3 lg:grid lg:grid-cols-2 lg:gap-3 lg:space-y-0">
            {loadingOrders ? (
              <div className="text-center text-muted-foreground py-8 lg:col-span-2">Loading…</div>
            ) : orders.length === 0 ? (
              <div className="text-center text-muted-foreground py-8 bg-card rounded-2xl border border-border lg:col-span-2">
                No airtime orders yet.
              </div>
            ) : (
              orders.map((o) => (
                <div key={o.id} className="bg-card rounded-2xl border border-border p-4 flex items-start justify-between gap-4">
                  <div className="space-y-0.5">
                    <p className="font-semibold text-sm text-foreground">{o.reference_code}</p>
                    <p className="text-xs text-muted-foreground">{o.network} → {o.beneficiary_phone}</p>
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" /> {new Date(o.created_at).toLocaleString()}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-bold text-foreground">GHS {o.airtime_amount.toFixed(2)}</p>
                    <p className="text-xs text-muted-foreground">Paid: GHS {o.total_paid.toFixed(2)}</p>
                    <span className={`inline-block mt-1 text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_CLASSES[o.status] || "bg-muted text-muted-foreground"}`}>
                      {o.status}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {purchaseModal && (
        <PurchaseSheet
          modal={purchaseModal}
          onCancel={handleCancelPurchase}
          onDismiss={handleDismissPurchase}
          accentColor="#1b388b"
          renderSuccess={(modal) => (
            <div className="px-5 pb-6 pt-2 text-center space-y-4">
              <div className="mx-auto w-16 h-16 rounded-full bg-success/15 flex items-center justify-center">
                <CheckCircle2 className="w-9 h-9 text-success" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-foreground">Order placed!</h3>
                <p className="text-sm text-muted-foreground mt-1">Your airtime order is confirmed and being processed.</p>
              </div>
              <div className="text-left p-4 rounded-2xl bg-muted/40 border border-border space-y-1.5 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Network</span><span className="font-medium">{modal.summary?.network}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">To</span><span className="font-medium">{modal.summary?.phone}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Amount</span><span className="font-bold">GHS {Number(modal.summary?.amount || 0).toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Reference</span><span className="font-mono text-xs">{modal.summary?.reference}</span></div>
              </div>
              <button onClick={handleDismissPurchase} className="w-full rounded-2xl bg-[#1b388b] py-3 text-sm font-bold text-white">Done</button>
            </div>
          )}
        />
      )}
    </DashboardLayout>
  )
}
