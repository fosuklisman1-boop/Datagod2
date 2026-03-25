"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { createClient } from "@supabase/supabase-js"
import { DashboardLayout } from "@/components/layout/dashboard-layout"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const NETWORKS = ["MTN", "Telecel", "AT"]
const NETWORK_COLORS: Record<string, string> = {
  MTN: "from-yellow-400 to-yellow-600",
  Telecel: "from-red-500 to-red-700",
  AT: "from-blue-500 to-blue-700",
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
  processing: "bg-blue-100 text-blue-800",
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

    // Fetch availability settings
    const { data: settingsData } = await supabase
      .from("admin_settings")
      .select("key, value")
      .in("key", [
        "airtime_enabled_mtn", "airtime_enabled_telecel", "airtime_enabled_at",
        `airtime_fee_mtn_${isDealer ? 'dealer' : 'customer'}`,
        `airtime_fee_telecel_${isDealer ? 'dealer' : 'customer'}`,
        `airtime_fee_at_${isDealer ? 'dealer' : 'customer'}`
      ])

    // Filter networks
    const enabledNets = ["MTN", "Telecel", "AT"].filter(n => {
      const setting = settingsData?.find(s => s.key === `airtime_enabled_${n.toLowerCase()}`)
      return setting?.value?.enabled !== false
    })

    setAvailableNetworks(enabledNets)
    
    // Auto-switch network if current is disabled
    if (enabledNets.length > 0 && !enabledNets.includes(network)) {
      setNetwork(enabledNets[0])
    }

    // Set specific fee for current network
    const netKey = network.toLowerCase()
    const feeSetting = settingsData?.find(s => s.key === `airtime_fee_${netKey}_${isDealer ? 'dealer' : 'customer'}`)
    setFeeRate(feeSetting?.value?.rate ?? 5)
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
          <h1 className="text-2xl font-bold text-gray-900">Buy Airtime</h1>
          <p className="text-gray-500 text-sm mt-1">
            Wallet balance:{" "}
            <span className="font-semibold text-gray-800">
              {walletBalance !== null ? `GHS ${walletBalance.toFixed(2)}` : "Loading…"}
            </span>
          </p>
        </div>

        {/* Network Selector */}
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
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
            <div className="bg-red-50 text-red-700 p-4 rounded-xl border border-red-100 text-center font-medium">
              Airtime services are temporarily unavailable. Please check back later.
            </div>
          )}
        </div>

        {/* Purchase Form */}
        <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-5">

          {/* Phone */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Beneficiary Phone Number</label>
            <input
              type="tel"
              inputMode="numeric"
              maxLength={10}
              value={phone}
              onChange={(e) => handlePhoneChange(e.target.value.replace(/\D/g, ""))}
              placeholder="e.g. 0244123456"
              required
              className="w-full border border-gray-200 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            {phoneError && <p className="text-xs text-amber-600 mt-1">{phoneError}</p>}
          </div>

          {/* Amount */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Airtime Amount (GHS)</label>
            <input
              type="number"
              min="1"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 10"
              required
              className="w-full border border-gray-200 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          {/* Pay Separately Toggle */}
          <div className="flex items-start gap-3 p-4 bg-indigo-50 rounded-xl">
            <input
              id="pay-sep"
              type="checkbox"
              checked={paySeparately}
              onChange={(e) => setPaySeparately(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-indigo-600 cursor-pointer"
            />
            <label htmlFor="pay-sep" className="text-sm cursor-pointer">
              <span className="font-semibold text-indigo-800">Pay fee separately</span>
              <br />
              <span className="text-indigo-700">
                {paySeparately
                  ? `Recipient gets the full amount you enter; service fee is added on top.`
                  : `Service fee is deducted from the amount before delivery.`}
              </span>
            </label>
          </div>

          {/* Fee breakdown */}
          {numAmount > 0 && (
            <div className="bg-gray-50 rounded-xl p-4 space-y-2 text-sm">
              <div className="flex justify-between text-gray-600">
                <span>Recipient gets</span>
                <span className="font-semibold text-gray-900">GHS {airtimeToRecipient.toFixed(2)}</span>
              </div>
              <p className="text-xs text-gray-500 flex justify-between">
                <span>Network Fee ({(userRole === 'dealer' || userRole === 'sub_agent') ? 'Dealer/Sub-Agent' : 'Standard'}):</span>
                <span className="font-medium text-gray-900">{feeRate}%</span>
              </p>
              <div className="flex justify-between text-gray-600">
                <span>Service fee ({feeRate}%)</span>
                <span>GHS {feeAmount.toFixed(2)}</span>
              </div>
              <div className="flex justify-between font-bold text-gray-900 border-t border-gray-200 pt-2">
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
            className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl transition-colors"
          >
            {submitting ? "Processing…" : `Buy Airtime — GHS ${totalPaid > 0 ? totalPaid.toFixed(2) : "0.00"}`}
          </button>
        </form>

        {/* Order History */}
        <div>
          <h2 className="text-lg font-bold text-gray-900 mb-3">Order History</h2>
          {loadingOrders ? (
            <div className="text-center text-gray-400 py-8">Loading…</div>
          ) : orders.length === 0 ? (
            <div className="text-center text-gray-400 py-8 bg-white rounded-2xl border border-gray-100">
              No airtime orders yet.
            </div>
          ) : (
            <div className="space-y-3">
              {orders.map((o) => (
                <div key={o.id} className="bg-white rounded-xl border border-gray-100 p-4 flex items-start justify-between gap-4">
                  <div className="space-y-0.5">
                    <p className="font-semibold text-sm text-gray-900">{o.reference_code}</p>
                    <p className="text-xs text-gray-500">{o.network} → {o.beneficiary_phone}</p>
                    <p className="text-xs text-gray-500">{new Date(o.created_at).toLocaleString()}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-bold text-gray-900">GHS {o.airtime_amount.toFixed(2)}</p>
                    <p className="text-xs text-gray-400">Paid: GHS {o.total_paid.toFixed(2)}</p>
                    <span className={`inline-block mt-1 text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_CLASSES[o.status] || "bg-gray-100 text-gray-600"}`}>
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
