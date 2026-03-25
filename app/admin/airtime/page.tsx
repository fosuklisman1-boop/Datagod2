"use client"

import { useState, useEffect, useCallback } from "react"
import { createClient } from "@supabase/supabase-js"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

interface AirtimeOrder {
  id: string
  reference_code: string
  network: string
  beneficiary_phone: string
  airtime_amount: number
  fee_amount: number
  total_paid: number
  status: string
  notes: string | null
  created_at: string
  users?: { email: string }
  user_shops?: { shop_name: string }
  customer_name: string | null
  customer_email: string | null
  merchant_commission: number
}

interface Stats {
  totalRevenue: number
  totalProfit: number
  totalMerchantPayout: number
  totalVolume: number
  pending: number
  processing: number
  completed: number
  failed: number
}

const STATUS_CLASSES: Record<string, string> = {
  pending:    "bg-yellow-100 text-yellow-800",
  processing: "bg-blue-100 text-blue-800",
  completed:  "bg-green-100 text-green-800",
  failed:     "bg-red-100 text-red-800",
}

export default function AdminAirtimePage() {
  const router = useRouter()
  const [orders, setOrders]       = useState<AirtimeOrder[]>([])
  const [stats, setStats]         = useState<Stats | null>(null)
  const [loading, setLoading]     = useState(true)
  const [token, setToken]         = useState<string | null>(null)

  // Filters
  const [date, setDate]           = useState("") // Default to empty for all dates
  const [network, setNetwork]     = useState("all")
  const [status, setStatus]       = useState("all")
  const [search, setSearch]       = useState("")

  // Action modal
  const [actionModal, setActionModal] = useState<{ order: AirtimeOrder; action: "completed" | "failed" } | null>(null)
  const [notes, setNotes]         = useState("")
  const [actioning, setActioning] = useState(false)
  const [actionMsg, setActionMsg] = useState("")

  // Copy feedback
  const [copiedId, setCopiedId]   = useState<string | null>(null)

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  const getToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push("/auth/login"); return null }
    setToken(session.access_token)
    return session.access_token
  }, [router])

  const loadOrders = useCallback(async (tok?: string) => {
    const t = tok || token
    if (!t) return
    setLoading(true)
    const params = new URLSearchParams({ date, network, status })
    if (search) params.set("search", search)
    const res = await fetch(`/api/admin/airtime/list?${params}`, {
      headers: { Authorization: `Bearer ${t}` },
    })
    if (res.status === 403) { router.push("/dashboard"); return }
    const data = await res.json()
    if (!res.ok) {
      console.error("[ADMIN-AIRTIME] Fetch error:", data.error)
      setOrders([])
      setStats(null)
    } else {
      setOrders(data.orders || [])
      setStats(data.stats || null)
    }
    setLoading(false)
  }, [token, date, network, status, search, router])

  useEffect(() => {
    getToken().then(t => { if (t) loadOrders(t) })
  }, [])

  useEffect(() => {
    if (token) loadOrders()
  }, [date, network, status])

  const handleSearch = (e: React.FormEvent) => { e.preventDefault(); loadOrders() }

  const handleAction = async () => {
    if (!actionModal || !token) return
    setActioning(true)
    setActionMsg("")
    const res = await fetch("/api/admin/airtime/action", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ orderId: actionModal.order.id, action: actionModal.action, notes }),
    })
    const data = await res.json()
    setActioning(false)
    if (res.ok) {
      setActionModal(null)
      setNotes("")
      loadOrders()
    } else {
      setActionMsg(data.error || "Action failed")
    }
  }

  const statCards = stats
    ? [
        { label: "Revenue",   value: `GHS ${Number(stats.totalRevenue || 0).toFixed(2)}`,  color: "text-indigo-600" },
        { label: "Net Profit", value: `GHS ${Number(stats.totalProfit || 0).toFixed(2)}`,   color: "text-green-600" },
        { label: "Merchant Payout", value: `GHS ${Number(stats.totalMerchantPayout || 0).toFixed(2)}`, color: "text-orange-600" },
        { label: "Volume",    value: `GHS ${Number(stats.totalVolume || 0).toFixed(2)}`,   color: "text-blue-600" },
        { label: "Pending",   value: stats.pending,                            color: "text-yellow-600" },
        { label: "Completed", value: stats.completed,                          color: "text-emerald-600" },
      ]
    : []

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">Airtime Orders</h1>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {statCards.map((s) => (
            <div key={s.label} className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 text-center">
              <p className="text-xs text-gray-400 uppercase tracking-wide">{s.label}</p>
              <p className={`text-lg font-bold mt-1 ${s.color}`}>{s.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <form onSubmit={handleSearch} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Date</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Network</label>
          <select value={network} onChange={e => setNetwork(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <option value="all">All</option>
            <option>MTN</option><option>Telecel</option><option>AT</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
          <select value={status} onChange={e => setStatus(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <option value="all">All</option>
            <option>pending</option><option>processing</option><option>completed</option><option>failed</option>
          </select>
        </div>
        <div className="flex-1 min-w-[180px]">
          <label className="block text-xs font-medium text-gray-500 mb-1">Search</label>
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Reference or Phone…"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </div>
        <button type="submit"
          className="bg-indigo-600 text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-indigo-700 transition-colors">
          Search
        </button>
      </form>

      {/* Orders Table */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-x-auto">
        {loading ? (
          <div className="text-center text-gray-400 py-12">Loading…</div>
        ) : orders.length === 0 ? (
          <div className="text-center text-gray-400 py-12">No orders found.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                {["Reference","Customer","Shop","Network","Phone","Airtime","Fee","Payout","Total","Status","Date","Actions"].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {orders.map((o) => (
                <tr key={o.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-gray-800">{o.reference_code}</td>
                  <td className="px-4 py-3">
                    <p className="text-xs font-medium text-gray-900 truncate max-w-[120px]" title={o.users?.email || o.customer_email || "Guest"}>
                      {o.users?.email || o.customer_email || o.customer_name || "Guest"}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-xs text-gray-600 italic">
                      {o.user_shops?.shop_name || "Direct"}
                    </p>
                  </td>
                  <td className="px-4 py-3 font-semibold text-gray-700">{o.network}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => copyToClipboard(o.beneficiary_phone, o.id)}
                      title="Click to copy"
                      className="font-mono text-xs bg-gray-100 hover:bg-indigo-100 text-gray-800 px-2 py-1 rounded transition-colors"
                    >
                      {copiedId === o.id ? "✓ Copied!" : o.beneficiary_phone}
                    </button>
                  </td>
                  <td className="px-4 py-3 font-semibold text-gray-900">GHS {Number(o.airtime_amount || 0).toFixed(2)}</td>
                  <td className="px-4 py-3 text-gray-500">GHS {Number(o.fee_amount || 0).toFixed(2)}</td>
                  <td className="px-4 py-3 text-orange-600 font-medium">GHS {Number(o.merchant_commission || 0).toFixed(2)}</td>
                  <td className="px-4 py-3 font-semibold text-indigo-700">GHS {Number(o.total_paid || 0).toFixed(2)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block text-xs font-bold px-2 py-0.5 rounded-full ${STATUS_CLASSES[o.status || 'pending'] || "bg-gray-100 text-gray-600"}`}>
                      {(o.status || 'pending').toUpperCase()}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">
                    {new Date(o.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    {(o.status === "pending" || o.status === "processing") && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => { setActionModal({ order: o, action: "completed" }); setNotes(""); setActionMsg("") }}
                          className="text-xs bg-green-50 text-green-700 hover:bg-green-100 font-semibold px-3 py-1 rounded-lg transition-colors"
                        >Complete</button>
                        <button
                          onClick={() => { setActionModal({ order: o, action: "failed" }); setNotes(""); setActionMsg("") }}
                          className="text-xs bg-red-50 text-red-700 hover:bg-red-100 font-semibold px-3 py-1 rounded-lg transition-colors"
                        >Fail</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Action Modal */}
      {actionModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4">
            <h3 className="text-lg font-bold text-gray-900">
              {actionModal.action === "completed" ? "✅ Mark as Completed" : "❌ Mark as Failed"}
            </h3>
            <div className="bg-gray-50 rounded-xl p-4 text-sm space-y-1">
              <p><span className="text-gray-500">Ref:</span> <strong>{actionModal.order.reference_code}</strong></p>
              <p><span className="text-gray-500">Network:</span> {actionModal.order.network}</p>
              <p><span className="text-gray-500">Phone:</span> {actionModal.order.beneficiary_phone}</p>
              <p><span className="text-gray-500">Airtime:</span> GHS {Number(actionModal.order.airtime_amount || 0).toFixed(2)}</p>
              {actionModal.action === "failed" && (
                <p className="text-red-600 font-semibold mt-2">⚠ GHS {Number(actionModal.order.total_paid || 0).toFixed(2)} will be refunded to the user's wallet.</p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Notes (optional)</label>
              <input
                type="text"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder={actionModal.action === "failed" ? "e.g. Network unreachable" : "e.g. Sent via MTN portal"}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            {actionMsg && <p className="text-red-600 text-sm">{actionMsg}</p>}
            <div className="flex gap-3 justify-end">
              <button onClick={() => setActionModal(null)}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 font-medium">
                Cancel
              </button>
              <button
                onClick={handleAction}
                disabled={actioning}
                className={`px-5 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50 transition-colors ${
                  actionModal.action === "completed"
                    ? "bg-green-600 hover:bg-green-700"
                    : "bg-red-600 hover:bg-red-700"
                }`}
              >
                {actioning ? "Processing…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </DashboardLayout>
  )
}
