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
}

export function FeeSettings() {
  const { user } = useAuth()
  const [settings, setSettings] = useState<FeeSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  // Form state
  const [formData, setFormData] = useState<FeeSettings>({
    paystack_fee_percentage: 3.0,
    wallet_topup_fee_percentage: 0,
    join_community_link: "",
    announcement_enabled: false,
    announcement_title: "",
    announcement_message: "",
  })

  useEffect(() => {
    loadSettings()
  }, [user])

  const loadSettings = async () => {
    if (!user) return

    try {
      setLoading(true)
      setError(null)

      const token = user.id // This should be the actual auth token
      const response = await fetch("/api/admin/settings", {
        headers: {
          "Authorization": `Bearer ${await getAuthToken()}`,
        },
      })

      if (!response.ok) {
        throw new Error("Failed to load settings")
      }

      const data = await response.json()
      setSettings(data)
      setFormData({
        paystack_fee_percentage: data.paystack_fee_percentage || 3.0,
        wallet_topup_fee_percentage: data.wallet_topup_fee_percentage || 0,
        join_community_link: data.join_community_link || "",
        announcement_enabled: data.announcement_enabled || false,
        announcement_title: data.announcement_title || "",
        announcement_message: data.announcement_message || "",
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load settings")
      console.error("Error loading settings:", err)
    } finally {
      setLoading(false)
    }
  }

  const getAuthToken = async () => {
    // Get token from Supabase auth
    const { data } = await (await import("@supabase/supabase-js")).createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    ).auth.getSession()
    
    return data.session?.access_token || ""
  }

  const handleInputChange = (
    field: keyof FeeSettings,
    value: string | number | boolean
  ) => {
    setFormData((prev) => ({
      ...prev,
      [field]: value,
    }))
  }

  const validateForm = (): boolean => {
    if (!formData.join_community_link) {
      setError("Community link is required")
      return false
    }

    try {
      new URL(formData.join_community_link)
    } catch {
      setError("Invalid URL format for community link")
      return false
    }

    if (formData.paystack_fee_percentage < 0 || formData.paystack_fee_percentage > 100) {
      setError("Paystack fee must be between 0 and 100")
      return false
    }

    if (formData.wallet_topup_fee_percentage < 0 || formData.wallet_topup_fee_percentage > 100) {
      setError("Wallet topup fee must be between 0 and 100")
      return false
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
      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify(formData),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || "Failed to save settings")
      }

      const data = await response.json()
      setSettings(data.settings)
      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings")
      console.error("Error saving settings:", err)
    } finally {
      setSaving(false)
    }
  }

  if (!user) {
    return (
      <div className="text-center text-gray-500">
        Please log in to access settings
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Fee Settings */}
      <Card>
        <CardHeader>
          <CardTitle>Payment Fees</CardTitle>
          <CardDescription>
            Configure payment processing fees for your platform
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Paystack Fee */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">
              Paystack Fee Percentage
              <span className="text-xs text-gray-500 ml-2">(default: 3%)</span>
            </label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={formData.paystack_fee_percentage}
                onChange={(e) =>
                  handleInputChange("paystack_fee_percentage", parseFloat(e.target.value))
                }
                className="flex-1"
                placeholder="3.0"
              />
              <span className="text-sm font-medium text-gray-600 w-8">%</span>
            </div>
            <p className="text-xs text-gray-500">
              Fee charged on all Paystack wallet top-ups. Matches Paystack's standard rate.
            </p>
          </div>

          {/* Wallet Topup Fee */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">
              Wallet Top-up Fee Percentage
              <span className="text-xs text-gray-500 ml-2">(default: 0%)</span>
            </label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={formData.wallet_topup_fee_percentage}
                onChange={(e) =>
                  handleInputChange("wallet_topup_fee_percentage", parseFloat(e.target.value))
                }
                className="flex-1"
                placeholder="0"
              />
              <span className="text-sm font-medium text-gray-600 w-8">%</span>
            </div>
            <p className="text-xs text-gray-500">
              Additional fee charged on top-ups. Set to 0 for no additional fee.
            </p>
          </div>

          {/* Fee Preview */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-2">
            <h4 className="font-semibold text-sm text-blue-900">Fee Preview</h4>
            <div className="text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-blue-700">Amount to top up:</span>
                <span className="font-medium text-blue-900">GHS 100.00</span>
              </div>
              <div className="flex justify-between">
                <span className="text-blue-700">
                  Paystack fee ({formData.paystack_fee_percentage}%):
                </span>
                <span className="font-medium text-blue-900">
                  GHS {(100 * formData.paystack_fee_percentage / 100).toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-blue-700">
                  Wallet topup fee ({formData.wallet_topup_fee_percentage}%):
                </span>
                <span className="font-medium text-blue-900">
                  GHS {(100 * formData.wallet_topup_fee_percentage / 100).toFixed(2)}
                </span>
              </div>
              <div className="border-t border-blue-200 pt-1 flex justify-between">
                <span className="text-blue-900 font-semibold">Total charge:</span>
                <span className="font-bold text-blue-900">
                  GHS {(100 + (100 * formData.paystack_fee_percentage / 100) + (100 * formData.wallet_topup_fee_percentage / 100)).toFixed(2)}
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Community Settings */}
      <Card>
        <CardHeader>
          <CardTitle>Community Settings</CardTitle>
          <CardDescription>
            Configure community links and announcements
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">
              Join Community Link
            </label>
            <Input
              type="url"
              value={formData.join_community_link}
              onChange={(e) =>
                handleInputChange("join_community_link", e.target.value)
              }
              placeholder="https://example.com"
            />
            <p className="text-xs text-gray-500">
              URL for users to join your community (e.g., Discord, WhatsApp)
            </p>
          </div>

          {/* Announcement Toggle */}
          <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
            <input
              type="checkbox"
              id="announcement_enabled"
              checked={formData.announcement_enabled}
              onChange={(e) =>
                handleInputChange("announcement_enabled", e.target.checked)
              }
              className="rounded"
            />
            <label htmlFor="announcement_enabled" className="text-sm font-medium text-gray-700">
              Enable Announcement
            </label>
          </div>

          {/* Announcement Fields */}
          {formData.announcement_enabled && (
            <div className="space-y-4 p-4 bg-amber-50 border border-amber-200 rounded-lg">
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700">
                  Announcement Title
                </label>
                <Input
                  type="text"
                  value={formData.announcement_title}
                  onChange={(e) =>
                    handleInputChange("announcement_title", e.target.value)
                  }
                  placeholder="Important Update"
                  maxLength={255}
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700">
                  Announcement Message
                </label>
                <textarea
                  value={formData.announcement_message}
                  onChange={(e) =>
                    handleInputChange("announcement_message", e.target.value)
                  }
                  placeholder="Type your announcement message here..."
                  rows={4}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Error Alert */}
      {error && (
        <div className="flex gap-3 p-4 bg-red-50 border border-red-200 rounded-lg">
          <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div>
            <h3 className="font-medium text-red-900">Error</h3>
            <p className="text-sm text-red-700 mt-1">{error}</p>
          </div>
        </div>
      )}

      {/* Success Alert */}
      {success && (
        <div className="flex gap-3 p-4 bg-green-50 border border-green-200 rounded-lg">
          <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
          <div>
            <h3 className="font-medium text-green-900">Success</h3>
            <p className="text-sm text-green-700 mt-1">Settings saved successfully</p>
          </div>
        </div>
      )}

      {/* Save Button */}
      <div className="flex gap-3">
        <Button
          onClick={handleSave}
          disabled={saving}
          className="gap-2"
        >
          {saving ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving...
            </>
          ) : (
            "Save Settings"
          )}
        </Button>
        <Button
          onClick={loadSettings}
          variant="outline"
          disabled={loading || saving}
        >
          Reset
        </Button>
      </div>
    </div>
  )
}
