"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { supabase } from "@/lib/supabase"

const NETWORKS = ["MTN", "Telecel", "AT"]
const NETWORK_COLORS: Record<string, string> = {
  MTN: "from-yellow-400 to-yellow-600",
  Telecel: "from-red-500 to-red-700",
  AT: "from-primary to-primary/80",
}
const NETWORK_PREFIXES: Record<string, string[]> = {
  MTN:     ["024", "054", "055", "059", "025"],
  Telecel: ["050", "020"],
  AT:      ["027", "057", "026", "028"],
}

function detectNetworkFromPhone(phone: string): string | null {
  const local = phone.startsWith("0") ? phone : phone
  const prefix = local.substring(0, 3)
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
  pending:    "bg-yellow-100 text-yellow-800",
  processing: "bg-primary/10 text-primary",
  completed:  "bg-green-100 text-green-800",
  failed:     "bg-red-100 text-red-800",
}

export default function AirtimePage() {
  const router = useRouter()

  // Form state
  const [network, setNetwork]           = useState("MTN")
  const [phone, setPhone]               = useState("")
  const [amount, setAmount]             = useState("")
  const [paySeparately, setPaySeparately] = useState(false)

  // Derived
  const [feeRate, setFeeRate]           = useState(5)
  const [userRole, setUserRole]         = useState("user")
  const [walletBalance, setWalletBalance] = useState<number | null>(null)
  const [phoneError, setPhoneError]     = useState("")

  // Orders
  const [orders, setOrders]             = useState<AirtimeOrder[]>([])
  const [loadingOrders, setLoadingOrders] = useState(true)

  // Submission
  const [submitting, setSubmitting]     = useState(false)
  const [message, setMessage]           = useState<{ type: "success" | "error"; text: string } | null>(null)

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

  const [availableNetworks, setAvailableNetworks] = useState<string[]>(["MTN", "Telecel", "AT"])

  // ----- Load wallet balance & fee from settings -----
  const loadSettings = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push("/auth/login"); return }

    // Fetch basic user context
    const [walletRes, roleRes] = await Promise.all([
      supabase.from("wallets").select("balance").eq("user_id", session.user.id).single(),
      supabase.from("users").select("role").eq("id", session.user.id).single(),
    ])
    setWalletBalance(walletRes.data?.balance ?? 0)
    const role = roleRes.data?.role || "user"
    setUserRole(role)
    const isDealer = role === "dealer" || role === "sub_agent"

    // Fetch availability settings via curated public-config (admin_settings is
    // service-role only). cfg.admin_settings is a key→value map of airtime_* keys.
    let airtimeSettings: Record<string, any> = {}
    try {
      const res = await fetch("/api/public/config")
      if (res.ok) {
        const cfg = await res.json()
        airtimeSettings = cfg.admin_settings ?? {}
      }
    } catch (e) {
      console.warn("Could not load airtime config:", e)
    }

    // Filter networks
    const enabledNets = ["MTN", "Telecel", "AT"].filter(n => {
      const setting = airtimeSettings[`airtime_enabled_${n.toLowerCase()}`]
      return setting?.enabled !== false
    })

    setAvailableNetworks(enabledNets)
    
    // Auto-switch network if current is disabled
    if (enabledNets.length > 0 && !enabledNets.includes(network)) {
      setNetwork(enabledNets[0])
    }

    // Set specific fee for current network
    const netKey = network.toLowerCase()
    const feeSetting = airtimeSettings[`airtime_fee_${netKey}_${isDealer ? 'dealer' : 'customer'}`]
    setFeeRate(feeSetting?.rate ?? 5)
  }, [network, router])

  // ----- Load order history -----
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

  // ----- Phone validation -----
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

  // ----- Submit -----
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (phoneError) return
    setSubmitting(true)
    setMessage(null)
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
        setMessage({ type: "error", text: data.error || "Purchase failed" })
      } else {
        setMessage({ type: "success", text: `Order placed! Ref: ${data.order.reference_code}` })
        setPhone("")
        setAmount("")
        setWalletBalance(data.newBalance)
        loadOrders()
      }
    } catch {
      setMessage({ type: "error", text: "Something went wrong. Please try again." })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <DashboardLayout>
      <div className="max-w-2xl mx-auto space-y-8">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-foreground">Buy Airtime</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Wallet balance:{" "}
            <span className="font-semibold text-foreground">
              {walletBalance !== null ? `GHS ${Math.max(0, walletBalance).toFixed(2)}` : "Loading…"}
            </span>
          </p>
        </div>

        {/* Network Selector */}
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            {availableNetworks.map((n) => (
              <button
                key={n}
                onClick={() => setNetwork(n)}
                className={`py-3 rounded-xl font-semibold text-white bg-gradient-to-br transition-all shadow-sm
                  ${NETWORK_COLORS[n]}
                  ${network === n ? "ring-2 ring-offset-2 ring-gray-800 scale-105" : "opacity-70 hover:opacity-100"}`}
              >
                {n}
              </button>
            ))}
          </div>
          {availableNetworks.length === 0 && !loadingOrders && (
            <div className="bg-red-50 text-red-700 p-4 rounded-xl border border-border text-center font-medium">
              Airtime services are temporarily unavailable. Please check back later.
            </div>
          )}
        </div>

        {/* Purchase Form */}
        <form onSubmit={handleSubmit} className="bg-card rounded-2xl shadow-sm border border-border p-6 space-y-5">

          {/* Phone */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Beneficiary Phone Number</label>
            <input
              type="tel"
              inputMode="numeric"
              maxLength={10}
              value={phone}
              onChange={(e) => handlePhoneChange(e.target.value.replace(/\D/g, ""))}
              placeholder="e.g. 0244123456"
              required
              className="w-full border border-border rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
            {phoneError && <p className="text-xs text-amber-600 mt-1">{phoneError}</p>}
          </div>

          {/* Amount */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Airtime Amount (GHS)</label>
            <input
              type="number"
              min="1"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 10"
              required
              className="w-full border border-border rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          {/* Pay Separately Toggle */}
          <div className="flex items-start gap-3 p-4 bg-primary rounded-xl">
            <input
              id="pay-sep"
              type="checkbox"
              checked={paySeparately}
              onChange={(e) => setPaySeparately(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-primary cursor-pointer"
            />
            <label htmlFor="pay-sep" className="text-sm cursor-pointer">
              <span className="font-semibold text-primary">Pay fee separately</span>
              <br />
              <span className="text-primary">
                {paySeparately
                  ? `Recipient gets the full amount you enter; service fee is added on top.`
                  : `Service fee is deducted from the amount before delivery.`}
              </span>
            </label>
          </div>

          {/* Fee breakdown */}
          {numAmount > 0 && (
            <div className="bg-muted/40 rounded-xl p-4 space-y-2 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>Recipient gets</span>
                <span className="font-semibold text-foreground">GHS {airtimeToRecipient.toFixed(2)}</span>
              </div>
              <p className="text-xs text-muted-foreground flex justify-between">
                <span>Network Fee ({(userRole === 'dealer' || userRole === 'sub_agent') ? 'Dealer/Sub-Agent' : 'Standard'}):</span>
                <span className="font-medium text-foreground">{feeRate}%</span>
              </p>
              <div className="flex justify-between text-muted-foreground">
                <span>Service fee ({feeRate}%)</span>
                <span>GHS {feeAmount.toFixed(2)}</span>
              </div>
              <div className="flex justify-between font-bold text-foreground border-t border-border pt-2">
                <span>You pay</span>
                <span>GHS {totalPaid.toFixed(2)}</span>
              </div>
              {walletBalance !== null && totalPaid > walletBalance && (
                <p className="text-red-600 text-xs font-medium">⚠ Insufficient wallet balance</p>
              )}
            </div>
          )}

          {/* Feedback message */}
          {message && (
            <div className={`text-sm rounded-lg px-4 py-3 font-medium ${
              message.type === "success" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"
            }`}>
              {message.text}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !!phoneError || !phone || !amount || (walletBalance !== null && totalPaid > walletBalance)}
            className="w-full bg-primary hover:bg-primary disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl transition-colors"
          >
            {submitting ? "Processing…" : `Buy Airtime — GHS ${totalPaid > 0 ? totalPaid.toFixed(2) : "0.00"}`}
          </button>
        </form>

        {/* Order History */}
        <div>
          <h2 className="text-lg font-bold text-foreground mb-3">Order History</h2>
          {loadingOrders ? (
            <div className="text-center text-muted-foreground py-8">Loading…</div>
          ) : orders.length === 0 ? (
            <div className="text-center text-muted-foreground py-8 bg-card rounded-2xl border border-border">
              No airtime orders yet.
            </div>
          ) : (
            <div className="space-y-3">
              {orders.map((o) => (
                <div key={o.id} className="bg-card rounded-xl border border-border p-4 flex items-start justify-between gap-4">
                  <div className="space-y-0.5">
                    <p className="font-semibold text-sm text-foreground">{o.reference_code}</p>
                    <p className="text-xs text-muted-foreground">{o.network} → {o.beneficiary_phone}</p>
                    <p className="text-xs text-muted-foreground">{new Date(o.created_at).toLocaleString()}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-bold text-foreground">GHS {o.airtime_amount.toFixed(2)}</p>
                    <p className="text-xs text-muted-foreground">Paid: GHS {o.total_paid.toFixed(2)}</p>
                    <span className={`inline-block mt-1 text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_CLASSES[o.status] || "bg-muted text-muted-foreground"}`}>
                      {o.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </DashboardLayout>
  )
}
