"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Save, AlertCircle, CheckCircle } from "lucide-react"
import { supabase } from "@/lib/supabase"

const NETWORKS = [
  { id: "mtn", name: "MTN" },
  { id: "telecel", name: "Telecel" },
  { id: "at", name: "AT" },
]

export default function AirtimeSettingsPage() {
  const router = useRouter()
  const [settings, setSettings] = useState<Record<string, any>>({})
  const [loading, setLoading]     = useState(true)
  const [saving, setSaving]       = useState(false)
  const [msg, setMsg]             = useState<{ text: string; type: "success" | "error" } | null>(null)
  const [token, setToken]         = useState<string | null>(null)

  const getToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push("/auth/login"); return null }
    setToken(session.access_token)
    return session.access_token
  }, [router])

  const loadSettings = useCallback(async (tok?: string) => {
    const t = tok || token
    if (!t) return
    setLoading(true)
    const res = await fetch("/api/admin/airtime/settings", {
      headers: { Authorization: `Bearer ${t}` },
    })
    const data = await res.json()
    if (res.ok) {
      setSettings(data.settings || {})
    } else {
      console.error("[AIRTIME-SETTINGS] Fetch error:", res.status, data.error)
      setMsg({ text: data.error || "Failed to load settings", type: "error" })
    }
    setLoading(false)
  }, [token])

  useEffect(() => {
    getToken().then(t => { if (t) loadSettings(t) })
  }, [getToken, loadSettings])

  const handleUpdateSetting = (key: string, value: any) => {
    setSettings(prev => ({ ...prev, [key]: value }))
  }

  const saveSettings = async () => {
    if (!token) return
    setSaving(true)
    setMsg(null)
    const res = await fetch("/api/admin/airtime/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ settings }),
    })
    const data = await res.json()
    setSaving(false)
    if (res.ok) {
      setMsg({ text: "Settings saved successfully", type: "success" })
    } else {
      setMsg({ text: data.error || "Failed to save settings", type: "error" })
    }
  }

  if (loading) return <DashboardLayout><div className="text-center py-20 font-medium text-muted-foreground">Loading Configuration…</div></DashboardLayout>

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto space-y-8">
        <header className="flex justify-between items-center bg-card p-6 rounded-2xl shadow-sm border border-border">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Airtime Management Settings</h1>
            <p className="text-sm text-muted-foreground">Configure network fees and service availability.</p>
          </div>
          <button
            onClick={saveSettings}
            disabled={saving}
            className="flex items-center gap-2 bg-indigo-600 text-white px-6 py-2.5 rounded-xl font-semibold shadow-lg shadow-indigo-200 hover:bg-indigo-700 transition-all disabled:opacity-50"
          >
            {saving ? <div className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </header>

        {msg && (
          <div className={`p-4 rounded-xl flex items-center gap-3 animate-in fade-in slide-in-from-top-4 ${
            msg.type === "success" ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"
          }`}>
            {msg.type === "success" ? <CheckCircle className="h-5 w-5" /> : <AlertCircle className="h-5 w-5" />}
            <span className="font-medium">{msg.text}</span>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Global Limits */}
          <div className="bg-card p-6 rounded-2xl shadow-sm border border-border space-y-4">
            <h2 className="text-lg font-bold text-foreground border-b pb-3">Global Limits</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Min Amount (GHS)</label>
                <input
                  type="number"
                  value={settings.airtime_min_amount?.amount || ""}
                  onChange={e => handleUpdateSetting("airtime_min_amount", { amount: parseFloat(e.target.value) })}
                  className="w-full border border-border rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Max Amount (GHS)</label>
                <input
                  type="number"
                  value={settings.airtime_max_amount?.amount || ""}
                  onChange={e => handleUpdateSetting("airtime_max_amount", { amount: parseFloat(e.target.value) })}
                  className="w-full border border-border rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                />
              </div>
            </div>
          </div>

          {/* Network Enable/Disable */}
          <div className="bg-card p-6 rounded-2xl shadow-sm border border-border space-y-4">
            <h2 className="text-lg font-bold text-foreground border-b pb-3">Service Availability</h2>
            <div className="space-y-3 pt-1">
              {NETWORKS.map(net => {
                const key = `airtime_enabled_${net.id}`
                const isEnabled = settings[key]?.enabled !== false
                return (
                  <div key={net.id} className="flex items-center justify-between p-3 bg-muted/40 rounded-xl">
                    <span className="font-semibold text-foreground">{net.name}</span>
                    <button
                      onClick={() => handleUpdateSetting(key, { enabled: !isEnabled })}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isEnabled ? 'bg-indigo-600' : 'bg-gray-300'}`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-card transition-transform ${isEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* Network Fees */}
        <div className="bg-card rounded-2xl shadow-sm border border-border overflow-hidden">
          <div className="p-6 border-b border-border">
            <h2 className="text-lg font-bold text-foreground">Network Fee Configuration</h2>
            <p className="text-sm text-muted-foreground">Set percentage fees for both regular customers and dealers.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/40 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                <tr>
                  <th className="px-6 py-4 text-left">Network</th>
                  <th className="px-6 py-4 text-left">Standard Customer (%)</th>
                  <th className="px-6 py-4 text-left">Dealer / Sub-Agent (%)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {NETWORKS.map(net => {
                  const customerKey = `airtime_fee_${net.id}_customer`
                  const dealerKey = `airtime_fee_${net.id}_dealer`
                  return (
                    <tr key={net.id} className="hover:bg-accent/50">
                      <td className="px-6 py-4 font-bold text-foreground">{net.name}</td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                            <input
                            type="number"
                            value={settings[customerKey]?.rate || ""}
                            onChange={e => handleUpdateSetting(customerKey, { rate: parseFloat(e.target.value) })}
                            className="w-24 border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                            />
                            <span className="text-muted-foreground font-medium">%</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                            <input
                            type="number"
                            value={settings[dealerKey]?.rate || ""}
                            onChange={e => handleUpdateSetting(dealerKey, { rate: parseFloat(e.target.value) })}
                            className="w-24 border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                            />
                            <span className="text-muted-foreground font-medium">%</span>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </DashboardLayout>
  )
}
