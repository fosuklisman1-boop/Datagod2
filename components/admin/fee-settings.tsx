"use client"

import { useState, useEffect } from "react"
import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

interface FeeSettings {
  paystack_fee_percentage: number
  wallet_topup_fee_percentage: number
  join_community_link: string
  announcement_enabled: boolean
  announcement_title: string
  announcement_message: string
  storefront_announcement_enabled: boolean
  storefront_announcement_title: string
  storefront_announcement_message: string
}

export function FeeSettings() {
  const { user } = useAuth()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  // app_settings state (single-row table)
  const [formData, setFormData] = useState<FeeSettings>({
    paystack_fee_percentage: 3.0,
    wallet_topup_fee_percentage: 0,
    join_community_link: "",
    announcement_enabled: false,
    announcement_title: "",
    announcement_message: "",
    storefront_announcement_enabled: false,
    storefront_announcement_title: "",
    storefront_announcement_message: "",
  })

  // admin_settings state (key-value table for airtime)
  const [airtimeData, setAirtimeData] = useState<any>({
    airtime_fee_mtn_customer: "0",
    airtime_fee_mtn_dealer: "0",
    airtime_fee_telecel_customer: "0",
    airtime_fee_telecel_dealer: "0",
    airtime_fee_at_customer: "0",
    airtime_fee_at_dealer: "0",
    airtime_min_amount: "1",
    airtime_max_amount: "1000",
    airtime_enabled_mtn: "true",
    airtime_enabled_telecel: "true",
    airtime_enabled_at: "true",
  })

  useEffect(() => {
    loadSettings()
  }, [user])

  const loadSettings = async () => {
    if (!user) return

    try {
      setLoading(true)
      setError(null)

      const token = await getAuthToken()
      
      // Load global app settings
      const appRes = await fetch("/api/admin/settings", {
        headers: { "Authorization": `Bearer ${token}` },
      })
      if (appRes.ok) {
        const data = await appRes.json()
        setFormData({
          paystack_fee_percentage: data.paystack_fee_percentage || 3.0,
          wallet_topup_fee_percentage: data.wallet_topup_fee_percentage || 0,
          join_community_link: data.join_community_link || "",
          announcement_enabled: data.announcement_enabled || false,
          announcement_title: data.announcement_title || "",
          announcement_message: data.announcement_message || "",
          storefront_announcement_enabled: data.storefront_announcement_enabled || false,
          storefront_announcement_title: data.storefront_announcement_title || "",
          storefront_announcement_message: data.storefront_announcement_message || "",
        })
      }

      // Load airtime settings
      const airtimeRes = await fetch("/api/admin/airtime/settings", {
        headers: { "Authorization": `Bearer ${token}` },
      })
      if (airtimeRes.ok) {
        const { settings } = await airtimeRes.json()
        setAirtimeData((prev: any) => ({ ...prev, ...settings }))
      }

    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load settings")
      console.error("Error loading settings:", err)
    } finally {
      setLoading(false)
    }
  }

  const getAuthToken = async () => {
    const { data } = await (await import("@supabase/supabase-js")).createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    ).auth.getSession()
    return data.session?.access_token || ""
  }

  const handleInputChange = (field: keyof FeeSettings, value: any) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
  }

  const handleAirtimeChange = (field: string, value: any) => {
    setAirtimeData((prev: any) => ({ ...prev, [field]: value }))
  }

  const validateForm = (): boolean => {
    if (formData.join_community_link) {
      try { new URL(formData.join_community_link) } catch {
        setError("Invalid URL format for community link")
        return false
      }
    }
    return true
  }

  const handleSave = async () => {
    if (!validateForm()) return

    try {
      setSaving(true)
      setError(null)
      setSuccess(false)

      const token = await getAuthToken()
      
      // Save app settings
      const appRes = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify(formData),
      })

      // Save airtime settings
      const airtimeRes = await fetch("/api/admin/airtime/settings", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({ settings: airtimeData }),
      })

      if (!appRes.ok || !airtimeRes.ok) {
        throw new Error("Failed to save some settings")
      }

      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings")
      console.error("Error saving settings:", err)
    } finally {
      setSaving(false)
    }
  }

  if (!user) return <div className="text-center text-gray-500">Please log in as Admin</div>
  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">System Settings</h1>
          <p className="text-gray-500 mt-1">Manage global fees, announcements, and airtime configuration</p>
        </div>
        <div className="flex gap-3">
          <Button onClick={loadSettings} variant="outline" disabled={loading || saving}>Reset</Button>
          <Button onClick={handleSave} disabled={saving} className="bg-blue-600 hover:bg-blue-700">
            {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving...</> : "Save All Changes"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          {/* Airtime Management */}
          <Card className="border-orange-200 shadow-sm">
            <CardHeader className="bg-orange-50/50 border-b border-orange-100">
              <CardTitle className="text-orange-900">Airtime Management</CardTitle>
              <CardDescription className="text-orange-700">Set network-specific fees and operational limits</CardDescription>
            </CardHeader>
            <CardContent className="pt-6 space-y-8">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* MTN */}
                <div className="space-y-4 p-4 rounded-xl bg-gray-50/50 border border-gray-100">
                  <div className="flex items-center justify-between border-b pb-2">
                    <h4 className="font-bold text-gray-900">MTN Ghana</h4>
                    <select 
                      value={airtimeData.airtime_enabled_mtn}
                      onChange={(e) => handleAirtimeChange("airtime_enabled_mtn", e.target.value)}
                      className="text-xs font-semibold px-2 py-1 rounded bg-white border"
                    >
                      <option value="true">Active</option>
                      <option value="false">Disabled</option>
                    </select>
                  </div>
                  <div className="grid grid-cols-1 gap-4">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-500">Customer Fee (GHS)</label>
                      <Input type="number" step="0.1" value={airtimeData.airtime_fee_mtn_customer} onChange={(e) => handleAirtimeChange("airtime_fee_mtn_customer", e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-500">Dealer/Sub-Agent Fee (GHS)</label>
                      <Input type="number" step="0.1" value={airtimeData.airtime_fee_mtn_dealer} onChange={(e) => handleAirtimeChange("airtime_fee_mtn_dealer", e.target.value)} />
                    </div>
                  </div>
                </div>

                {/* Telecel */}
                <div className="space-y-4 p-4 rounded-xl bg-gray-50/50 border border-gray-100">
                  <div className="flex items-center justify-between border-b pb-2">
                    <h4 className="font-bold text-gray-900">Telecel (Vodafone)</h4>
                    <select 
                      value={airtimeData.airtime_enabled_telecel}
                      onChange={(e) => handleAirtimeChange("airtime_enabled_telecel", e.target.value)}
                      className="text-xs font-semibold px-2 py-1 rounded bg-white border"
                    >
                      <option value="true">Active</option>
                      <option value="false">Disabled</option>
                    </select>
                  </div>
                  <div className="grid grid-cols-1 gap-4">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-500">Customer Fee (GHS)</label>
                      <Input type="number" step="0.1" value={airtimeData.airtime_fee_telecel_customer} onChange={(e) => handleAirtimeChange("airtime_fee_telecel_customer", e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-500">Dealer/Sub-Agent Fee (GHS)</label>
                      <Input type="number" step="0.1" value={airtimeData.airtime_fee_telecel_dealer} onChange={(e) => handleAirtimeChange("airtime_fee_telecel_dealer", e.target.value)} />
                    </div>
                  </div>
                </div>

                {/* AT */}
                <div className="space-y-4 p-4 rounded-xl bg-gray-50/50 border border-gray-100">
                  <div className="flex items-center justify-between border-b pb-2">
                    <h4 className="font-bold text-gray-900">AT (AirtelTigo)</h4>
                    <select 
                      value={airtimeData.airtime_enabled_at}
                      onChange={(e) => handleAirtimeChange("airtime_enabled_at", e.target.value)}
                      className="text-xs font-semibold px-2 py-1 rounded bg-white border"
                    >
                      <option value="true">Active</option>
                      <option value="false">Disabled</option>
                    </select>
                  </div>
                  <div className="grid grid-cols-1 gap-4">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-500">Customer Fee (GHS)</label>
                      <Input type="number" step="0.1" value={airtimeData.airtime_fee_at_customer} onChange={(e) => handleAirtimeChange("airtime_fee_at_customer", e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-500">Dealer/Sub-Agent Fee (GHS)</label>
                      <Input type="number" step="0.1" value={airtimeData.airtime_fee_at_dealer} onChange={(e) => handleAirtimeChange("airtime_fee_at_dealer", e.target.value)} />
                    </div>
                  </div>
                </div>

                {/* Limits */}
                <div className="space-y-4 p-4 rounded-xl bg-gray-800 text-white border border-gray-700 shadow-md">
                   <h4 className="font-bold text-white border-b border-gray-700 pb-2">Purchase Limits</h4>
                   <div className="grid grid-cols-1 gap-4 pt-2">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-400">Min Amount (GHS)</label>
                      <Input type="number" className="bg-gray-900 border-gray-700 text-white" value={airtimeData.airtime_min_amount} onChange={(e) => handleAirtimeChange("airtime_min_amount", e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-400">Max Amount (GHS)</label>
                      <Input type="number" className="bg-gray-900 border-gray-700 text-white" value={airtimeData.airtime_max_amount} onChange={(e) => handleAirtimeChange("airtime_max_amount", e.target.value)} />
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Payment Fees */}
          <Card className="shadow-sm">
            <CardHeader className="bg-gray-50/50 border-b border-gray-100">
              <CardTitle>Platform Fees</CardTitle>
              <CardDescription>Configure processing fees for wallet top-ups</CardDescription>
            </CardHeader>
            <CardContent className="pt-6 space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-700">Paystack Fee (%)</label>
                  <div className="flex items-center gap-2">
                    <Input type="number" value={formData.paystack_fee_percentage} onChange={(e) => handleInputChange("paystack_fee_percentage", parseFloat(e.target.value))} />
                    <span className="text-gray-500">%</span>
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-700">Wallet Top-up Extra Fee (%)</label>
                  <div className="flex items-center gap-2">
                    <Input type="number" value={formData.wallet_topup_fee_percentage} onChange={(e) => handleInputChange("wallet_topup_fee_percentage", parseFloat(e.target.value))} />
                    <span className="text-gray-500">%</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-8">
           {/* Community Settings */}
           <Card className="shadow-sm">
            <CardHeader>
              <CardTitle>Community</CardTitle>
              <CardDescription>Links & Announcements</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <label className="text-xs font-bold uppercase text-gray-500">Join Community Link</label>
                <Input type="url" value={formData.join_community_link} onChange={(e) => handleInputChange("join_community_link", e.target.value)} />
              </div>

              <div className="space-y-4 pt-4 border-t">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-semibold text-gray-700 font-medium">Internal Announcement</label>
                  <input type="checkbox" className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500" checked={formData.announcement_enabled} onChange={(e) => handleInputChange("announcement_enabled", e.target.checked)} />
                </div>
                {formData.announcement_enabled && (
                  <div className="space-y-3 p-3 bg-amber-50 rounded-lg border border-amber-100">
                    <Input placeholder="Title" value={formData.announcement_title} onChange={(e) => handleInputChange("announcement_title", e.target.value)} />
                    <textarea className="w-full text-sm p-3 rounded-md border border-gray-300 min-h-[100px]" placeholder="Message..." value={formData.announcement_message} onChange={(e) => handleInputChange("announcement_message", e.target.value)} />
                  </div>
                )}
              </div>

              <div className="space-y-4 pt-4 border-t">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-semibold text-gray-700 font-medium">Storefront Override</label>
                  <input type="checkbox" className="w-4 h-4 rounded text-purple-600 focus:ring-purple-500" checked={formData.storefront_announcement_enabled} onChange={(e) => handleInputChange("storefront_announcement_enabled", e.target.checked)} />
                </div>
                {formData.storefront_announcement_enabled && (
                  <div className="space-y-3 p-3 bg-purple-50 rounded-lg border border-purple-100">
                    <Input placeholder="Override Title" value={formData.storefront_announcement_title} onChange={(e) => handleInputChange("storefront_announcement_title", e.target.value)} />
                    <textarea className="w-full text-sm p-3 rounded-md border border-gray-300 min-h-[100px]" placeholder="Override Message..." value={formData.storefront_announcement_message} onChange={(e) => handleInputChange("storefront_announcement_message", e.target.value)} />
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {error && (
        <div className="flex gap-3 p-4 bg-red-50 border border-red-200 rounded-xl">
          <AlertCircle className="w-5 h-5 text-red-600 shrink-0" />
          <p className="text-sm text-red-700 font-medium">{error}</p>
        </div>
      )}

      {success && (
        <div className="fixed bottom-8 right-8 flex gap-3 p-4 bg-green-600 text-white rounded-xl shadow-2xl animate-in slide-in-from-bottom-5">
          <CheckCircle2 className="w-5 h-5" />
          <p className="text-sm font-bold">Settings saved successfully!</p>
        </div>
      )}
    </div>
  )
}
