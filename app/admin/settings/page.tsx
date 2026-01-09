"use client"

import { useEffect, useState } from "react"
import { useAdminProtected } from "@/hooks/use-admin"
import { useAuth } from "@/lib/auth-context"
import { supabase } from "@/lib/supabase"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { toast } from "sonner"
import { Loader2, Save, ExternalLink, MessageCircle, Copy, Check, Link as LinkIcon, Bell, DollarSign } from "lucide-react"
import { supportSettingsService } from "@/lib/support-settings-service"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import PhoneBlacklistManager from "@/components/admin/phone-blacklist-manager"

export default function AdminSettingsPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const { user } = useAuth()
  const [joinCommunityLink, setJoinCommunityLink] = useState("")
  const [whatsappNumber, setWhatsappNumber] = useState("")
  const [supportEmail, setSupportEmail] = useState("")
  const [supportPhone, setSupportPhone] = useState("")
  const [previewWhatsappUrl, setPreviewWhatsappUrl] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  
  // Announcement settings
  const [announcementEnabled, setAnnouncementEnabled] = useState(false)
  const [announcementTitle, setAnnouncementTitle] = useState("")
  const [announcementMessage, setAnnouncementMessage] = useState("")
  
  // Fee settings
  const [paystackFeePercentage, setPaystackFeePercentage] = useState(3.0)
  const [walletTopupFeePercentage, setWalletTopupFeePercentage] = useState(0)
  const [withdrawalFeePercentage, setWithdrawalFeePercentage] = useState(0)
  
  // Price adjustment settings (per network)
  const [priceAdjustmentMtn, setPriceAdjustmentMtn] = useState(0)
  const [priceAdjustmentTelecel, setPriceAdjustmentTelecel] = useState(0)
  const [priceAdjustmentAtIshare, setPriceAdjustmentAtIshare] = useState(0)
  const [priceAdjustmentAtBigtime, setPriceAdjustmentAtBigtime] = useState(0)
  
  // Christmas theme settings
  const [christmasThemeEnabled, setChristmasThemeEnabled] = useState(false)
  const [savingChristmasTheme, setSavingChristmasTheme] = useState(false)
  
  const [domainUrls] = useState([
    { name: "Main App", url: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000" },
    { name: "Admin Dashboard", url: `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/admin` },
    { name: "Dashboard", url: `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/dashboard` },
    { name: "Login", url: `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/auth/login` },
    { name: "Sign Up", url: `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/auth/signup` },
  ])

  // Fetch settings
  useEffect(() => {
    if (!user) return

    const fetchSettings = async () => {
      try {
        const response = await fetch("/api/admin/settings")
        const data = await response.json()

        if (data.join_community_link) {
          setJoinCommunityLink(data.join_community_link)
        }

        // Load support settings
        const supportSettings = await supportSettingsService.getSupportSettings()
        setWhatsappNumber(supportSettings?.support_whatsapp || "")
        setSupportEmail(supportSettings?.support_email || "")
        setSupportPhone(supportSettings?.support_phone || "")
        if (supportSettings?.support_whatsapp) {
          const url = supportSettingsService.formatWhatsAppURL(
            supportSettings.support_whatsapp,
            "Hi, I need help resetting my password."
          )
          setPreviewWhatsappUrl(url)
        }

        // Load announcement settings
        if (data.announcement_enabled !== undefined) {
          setAnnouncementEnabled(data.announcement_enabled)
        }
        if (data.announcement_title) {
          setAnnouncementTitle(data.annotation_title)
        }
        if (data.announcement_message) {
          setAnnouncementMessage(data.announcement_message)
        }

        // Load fee settings
        if (data.paystack_fee_percentage !== undefined) {
          setPaystackFeePercentage(data.paystack_fee_percentage)
        }
        if (data.wallet_topup_fee_percentage !== undefined) {
          setWalletTopupFeePercentage(data.wallet_topup_fee_percentage)
        }
        if (data.withdrawal_fee_percentage !== undefined) {
          setWithdrawalFeePercentage(data.withdrawal_fee_percentage)
        }

        // Load price adjustment settings
        if (data.price_adjustment_mtn !== undefined) {
          setPriceAdjustmentMtn(data.price_adjustment_mtn)
        }
        if (data.price_adjustment_telecel !== undefined) {
          setPriceAdjustmentTelecel(data.price_adjustment_telecel)
        }
        if (data.price_adjustment_at_ishare !== undefined) {
          setPriceAdjustmentAtIshare(data.price_adjustment_at_ishare)
        }
        if (data.price_adjustment_at_bigtime !== undefined) {
          setPriceAdjustmentAtBigtime(data.price_adjustment_at_bigtime)
        }

        // Load Christmas theme setting
        const christmasResponse = await fetch("/api/admin/christmas-theme")
        const christmasData = await christmasResponse.json()
        if (christmasData.christmas_theme_enabled !== undefined) {
          setChristmasThemeEnabled(christmasData.christmas_theme_enabled)
        }
      } catch (error) {
        console.error("[SETTINGS] Error fetching settings:", error)
        const errorMessage = error instanceof Error ? error.message : "Failed to load settings"
        toast.error(errorMessage)
      } finally {
        setLoading(false)
      }
    }

    fetchSettings()
  }, [user])

  const handleWhatsappChange = (value: string) => {
    setWhatsappNumber(value)
    if (value) {
      const url = supportSettingsService.formatWhatsAppURL(value, "Hi, I need help resetting my password.")
      setPreviewWhatsappUrl(url)
    } else {
      setPreviewWhatsappUrl("")
    }
  }

  const copyToClipboard = (url: string) => {
    navigator.clipboard.writeText(url)
    setCopiedUrl(url)
    toast.success("URL copied to clipboard!")
    setTimeout(() => setCopiedUrl(null), 2000)
  }

  const handleChristmasThemeToggle = async (enabled: boolean) => {
    setSavingChristmasTheme(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      
      if (!session?.access_token) {
        toast.error("Authentication required")
        setSavingChristmasTheme(false)
        return
      }

      const response = await fetch("/api/admin/christmas-theme", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ christmas_theme_enabled: enabled }),
      })

      if (!response.ok) {
        throw new Error("Failed to update Christmas theme")
      }

      setChristmasThemeEnabled(enabled)
      toast.success(
        enabled ? "🎄 Christmas theme enabled!" : "Christmas theme disabled"
      )
    } catch (error) {
      console.error("Error updating Christmas theme:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to update Christmas theme"
      toast.error(errorMessage)
    } finally {
      setSavingChristmasTheme(false)
    }
  }

  const handleSave = async () => {
    if (!joinCommunityLink.trim()) {
      toast.error("Please enter a join community link")
      return
    }

    if (!whatsappNumber.trim()) {
      toast.error("Please enter a WhatsApp number")
      return
    }

    // Validate URLs
    try {
      new URL(joinCommunityLink)
    } catch {
      toast.error("Please enter a valid community link URL")
      return
    }

    setSaving(true)
    try {
      // Get session directly from Supabase
      const { data: { session }, error: sessionError } = await supabase.auth.getSession()
      
      if (!session?.access_token) {
        toast.error("Authentication required. Please log in again.")
        setSaving(false)
        return
      }

      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          join_community_link: joinCommunityLink,
          announcement_enabled: announcementEnabled,
          announcement_title: announcementTitle,
          announcement_message: announcementMessage,
          paystack_fee_percentage: paystackFeePercentage,
          wallet_topup_fee_percentage: walletTopupFeePercentage,
          withdrawal_fee_percentage: withdrawalFeePercentage,
          price_adjustment_mtn: priceAdjustmentMtn,
          price_adjustment_telecel: priceAdjustmentTelecel,
          price_adjustment_at_ishare: priceAdjustmentAtIshare,
          price_adjustment_at_bigtime: priceAdjustmentAtBigtime,
        }),
      })

      const result = await response.json()

      if (!response.ok) {
        toast.error(result.error || "Failed to save settings")
        return
      }

      // Save support settings
      await supportSettingsService.updateSupportSettings(
        whatsappNumber,
        supportEmail,
        supportPhone
      )

      toast.success("Settings saved successfully!")
    } catch (error) {
      console.error("[SETTINGS] Error saving settings:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to save settings"
      toast.error(errorMessage)
    } finally {
      setSaving(false)
    }
  }

  if (adminLoading || loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-violet-600" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-8">
      <div className="max-w-2xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">App Settings</h1>
          <p className="text-gray-600 mt-2">
            Configure application-wide settings and community links
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ExternalLink className="w-5 h-5" />
              Join Community Link
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="joinLink" className="text-sm font-medium">
                Community Join Link
              </Label>
              <p className="text-xs text-gray-500 mt-1 mb-2">
                This link will be displayed to users who want to join your community
              </p>
              <Input
                id="joinLink"
                type="url"
                placeholder="https://discord.gg/..."
                value={joinCommunityLink}
                onChange={(e) => setJoinCommunityLink(e.target.value)}
                className="w-full"
              />
            </div>

            {joinCommunityLink && (
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                <p className="text-sm text-blue-700">
                  <span className="font-semibold">Preview:</span>{" "}
                  <a
                    href={joinCommunityLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline break-all"
                  >
                    {joinCommunityLink}
                  </a>
                </p>
              </div>
            )}

            <div className="flex gap-3 pt-4">
              <Button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700"
              >
                {saving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    Save Settings
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageCircle className="w-5 h-5 text-green-600" />
              Support Contact Settings
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="whatsapp" className="text-sm font-medium">
                WhatsApp Number (Required)
              </Label>
              <p className="text-xs text-gray-500 mt-1 mb-2">
                Used for password reset requests. Format: international without + (e.g., 233501234567)
              </p>
              <Input
                id="whatsapp"
                type="tel"
                placeholder="233501234567"
                value={whatsappNumber}
                onChange={(e) => handleWhatsappChange(e.target.value)}
                className="w-full"
              />
            </div>

            {previewWhatsappUrl && (
              <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                <p className="text-xs font-semibold text-green-900 mb-2">WhatsApp Link Preview:</p>
                <a
                  href={previewWhatsappUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-green-600 hover:text-green-700 hover:underline break-all"
                >
                  Open WhatsApp Chat
                </a>
              </div>
            )}

            <div>
              <Label htmlFor="supportEmail" className="text-sm font-medium">
                Support Email (Optional)
              </Label>
              <p className="text-xs text-gray-500 mt-1 mb-2">
                Shown as alternative contact method
              </p>
              <Input
                id="supportEmail"
                type="email"
                placeholder="support@example.com"
                value={supportEmail}
                onChange={(e) => setSupportEmail(e.target.value)}
                className="w-full"
              />
            </div>

            <div>
              <Label htmlFor="supportPhone" className="text-sm font-medium">
                Support Phone (Optional)
              </Label>
              <p className="text-xs text-gray-500 mt-1 mb-2">
                Local phone number format
              </p>
              <Input
                id="supportPhone"
                type="tel"
                placeholder="0501234567"
                value={supportPhone}
                onChange={(e) => setSupportPhone(e.target.value)}
                className="w-full"
              />
            </div>
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <DollarSign className="w-5 h-5 text-green-600" />
              Payment Fees
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="paystackFee" className="text-sm font-medium">
                Paystack Fee Percentage
              </Label>
              <p className="text-xs text-gray-500 mt-1 mb-2">
                Fee charged for Paystack payments (e.g., 3 for 3%)
              </p>
              <div className="flex items-center gap-2">
                <Input
                  id="paystackFee"
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={paystackFeePercentage}
                  onChange={(e) => setPaystackFeePercentage(parseFloat(e.target.value))}
                  className="flex-1"
                  placeholder="3.0"
                />
                <span className="text-sm font-medium text-gray-600">%</span>
              </div>
            </div>

            <div>
              <Label htmlFor="walletTopupFee" className="text-sm font-medium">
                Wallet Top-up Fee Percentage
              </Label>
              <p className="text-xs text-gray-500 mt-1 mb-2">
                Additional fee charged on top-ups (e.g., 2 for 2%)
              </p>
              <div className="flex items-center gap-2">
                <Input
                  id="walletTopupFee"
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={walletTopupFeePercentage}
                  onChange={(e) => setWalletTopupFeePercentage(parseFloat(e.target.value))}
                  className="flex-1"
                  placeholder="0"
                />
                <span className="text-sm font-medium text-gray-600">%</span>
              </div>
            </div>

            <div>
              <Label htmlFor="withdrawalFee" className="text-sm font-medium">
                Withdrawal Fee Percentage
              </Label>
              <p className="text-xs text-gray-500 mt-1 mb-2">
                Fee deducted from withdrawal requests (e.g., 5 for 5%)
              </p>
              <div className="flex items-center gap-2">
                <Input
                  id="withdrawalFee"
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={withdrawalFeePercentage}
                  onChange={(e) => setWithdrawalFeePercentage(parseFloat(e.target.value))}
                  className="flex-1"
                  placeholder="0"
                />
                <span className="text-sm font-medium text-gray-600">%</span>
              </div>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-3">
              <div>
                <h4 className="font-semibold text-sm text-blue-900 mb-2">Top-up Preview (GHS 100)</h4>
                <div className="text-sm space-y-1">
                  <div className="flex justify-between">
                    <span className="text-blue-700">Amount to top up:</span>
                    <span className="font-medium text-blue-900">GHS 100.00</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-blue-700">
                      Paystack fee ({paystackFeePercentage}%):
                    </span>
                    <span className="font-medium text-blue-900">
                      GHS {(100 * paystackFeePercentage / 100).toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-blue-700">
                      Wallet topup fee ({walletTopupFeePercentage}%):
                    </span>
                    <span className="font-medium text-blue-900">
                      GHS {(100 * walletTopupFeePercentage / 100).toFixed(2)}
                    </span>
                  </div>
                  <div className="border-t border-blue-200 pt-1 flex justify-between">
                    <span className="text-blue-900 font-semibold">Total charge:</span>
                    <span className="font-bold text-blue-900">
                      GHS {(100 + (100 * paystackFeePercentage / 100) + (100 * walletTopupFeePercentage / 100)).toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="border-t border-blue-200 pt-3">
                <h4 className="font-semibold text-sm text-blue-900 mb-2">Withdrawal Preview (GHS 100 Requested)</h4>
                <div className="text-sm space-y-1">
                  <div className="flex justify-between">
                    <span className="text-blue-700">Requested amount:</span>
                    <span className="font-medium text-blue-900">GHS 100.00</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-blue-700">
                      Withdrawal fee ({withdrawalFeePercentage}%):
                    </span>
                    <span className="font-medium text-orange-600">
                      -GHS {(100 * withdrawalFeePercentage / 100).toFixed(2)}
                    </span>
                  </div>
                  <div className="border-t border-blue-200 pt-1 flex justify-between">
                    <span className="text-blue-900 font-semibold">Shop receives:</span>
                    <span className="font-bold text-green-600">
                      GHS {(100 - (100 * withdrawalFeePercentage / 100)).toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex gap-3 pt-4">
              <Button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700"
              >
                {saving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    Save Settings
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Price Adjustment Settings */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <DollarSign className="w-5 h-5 text-orange-600" />
              Package Price Adjustments
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-gray-600">
              Adjust package prices by percentage for each network. Positive values increase prices (markup), 
              negative values decrease prices (discount). Applied at display time without changing base prices.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* MTN */}
              <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                <Label htmlFor="priceAdjMtn" className="text-sm font-medium text-yellow-900">
                  MTN Price Adjustment
                </Label>
                <div className="flex items-center gap-2 mt-2">
                  <Input
                    id="priceAdjMtn"
                    type="number"
                    min="-100"
                    max="100"
                    step="0.01"
                    value={priceAdjustmentMtn}
                    onChange={(e) => setPriceAdjustmentMtn(parseFloat(e.target.value) || 0)}
                    className="flex-1 bg-white"
                    placeholder="0"
                  />
                  <span className="text-sm font-medium text-yellow-800">%</span>
                </div>
                <p className="text-xs text-yellow-700 mt-1">
                  {priceAdjustmentMtn > 0 ? `+${priceAdjustmentMtn}% markup` : priceAdjustmentMtn < 0 ? `${priceAdjustmentMtn}% discount` : 'No adjustment'}
                </p>
              </div>

              {/* Telecel */}
              <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
                <Label htmlFor="priceAdjTelecel" className="text-sm font-medium text-red-900">
                  Telecel Price Adjustment
                </Label>
                <div className="flex items-center gap-2 mt-2">
                  <Input
                    id="priceAdjTelecel"
                    type="number"
                    min="-100"
                    max="100"
                    step="0.01"
                    value={priceAdjustmentTelecel}
                    onChange={(e) => setPriceAdjustmentTelecel(parseFloat(e.target.value) || 0)}
                    className="flex-1 bg-white"
                    placeholder="0"
                  />
                  <span className="text-sm font-medium text-red-800">%</span>
                </div>
                <p className="text-xs text-red-700 mt-1">
                  {priceAdjustmentTelecel > 0 ? `+${priceAdjustmentTelecel}% markup` : priceAdjustmentTelecel < 0 ? `${priceAdjustmentTelecel}% discount` : 'No adjustment'}
                </p>
              </div>

              {/* AT - iShare */}
              <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <Label htmlFor="priceAdjAtIshare" className="text-sm font-medium text-blue-900">
                  AT - iShare Price Adjustment
                </Label>
                <div className="flex items-center gap-2 mt-2">
                  <Input
                    id="priceAdjAtIshare"
                    type="number"
                    min="-100"
                    max="100"
                    step="0.01"
                    value={priceAdjustmentAtIshare}
                    onChange={(e) => setPriceAdjustmentAtIshare(parseFloat(e.target.value) || 0)}
                    className="flex-1 bg-white"
                    placeholder="0"
                  />
                  <span className="text-sm font-medium text-blue-800">%</span>
                </div>
                <p className="text-xs text-blue-700 mt-1">
                  {priceAdjustmentAtIshare > 0 ? `+${priceAdjustmentAtIshare}% markup` : priceAdjustmentAtIshare < 0 ? `${priceAdjustmentAtIshare}% discount` : 'No adjustment'}
                </p>
              </div>

              {/* AT - BigTime */}
              <div className="p-4 bg-purple-50 border border-purple-200 rounded-lg">
                <Label htmlFor="priceAdjAtBigtime" className="text-sm font-medium text-purple-900">
                  AT - BigTime Price Adjustment
                </Label>
                <div className="flex items-center gap-2 mt-2">
                  <Input
                    id="priceAdjAtBigtime"
                    type="number"
                    min="-100"
                    max="100"
                    step="0.01"
                    value={priceAdjustmentAtBigtime}
                    onChange={(e) => setPriceAdjustmentAtBigtime(parseFloat(e.target.value) || 0)}
                    className="flex-1 bg-white"
                    placeholder="0"
                  />
                  <span className="text-sm font-medium text-purple-800">%</span>
                </div>
                <p className="text-xs text-purple-700 mt-1">
                  {priceAdjustmentAtBigtime > 0 ? `+${priceAdjustmentAtBigtime}% markup` : priceAdjustmentAtBigtime < 0 ? `${priceAdjustmentAtBigtime}% discount` : 'No adjustment'}
                </p>
              </div>
            </div>

            {/* Preview */}
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mt-4">
              <h4 className="font-semibold text-sm text-gray-900 mb-3">Price Preview (GHS 10.00 base price)</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div className="text-center p-2 bg-yellow-100 rounded">
                  <p className="text-yellow-800 font-medium">MTN</p>
                  <p className="text-yellow-900 font-bold">
                    GHS {(10 * (1 + priceAdjustmentMtn / 100)).toFixed(2)}
                  </p>
                </div>
                <div className="text-center p-2 bg-red-100 rounded">
                  <p className="text-red-800 font-medium">Telecel</p>
                  <p className="text-red-900 font-bold">
                    GHS {(10 * (1 + priceAdjustmentTelecel / 100)).toFixed(2)}
                  </p>
                </div>
                <div className="text-center p-2 bg-blue-100 rounded">
                  <p className="text-blue-800 font-medium">AT-iShare</p>
                  <p className="text-blue-900 font-bold">
                    GHS {(10 * (1 + priceAdjustmentAtIshare / 100)).toFixed(2)}
                  </p>
                </div>
                <div className="text-center p-2 bg-purple-100 rounded">
                  <p className="text-purple-800 font-medium">AT-BigTime</p>
                  <p className="text-purple-900 font-bold">
                    GHS {(10 * (1 + priceAdjustmentAtBigtime / 100)).toFixed(2)}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex gap-3 pt-4">
              <Button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700"
              >
                {saving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    Save Settings
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <LinkIcon className="w-5 h-5 text-purple-600" />
              Quick URL Copy
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-gray-600">
              Quick access to important application URLs. Click to copy any URL to clipboard.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {domainUrls.map((item) => (
                <div
                  key={item.url}
                  className="flex items-center justify-between gap-2 p-3 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900">{item.name}</p>
                    <p className="text-xs text-gray-500 truncate">{item.url}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => copyToClipboard(item.url)}
                    className="flex-shrink-0"
                  >
                    {copiedUrl === item.url ? (
                      <Check className="w-4 h-4 text-green-600" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <LinkIcon className="w-5 h-5 text-purple-600" />
              Webhook URLs
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-gray-600">
              Configure these webhook URLs in your payment provider settings for real-time transaction updates.
            </p>
            <div className="space-y-3">
              <div className="p-4 border border-purple-200 bg-purple-50 rounded-lg space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-gray-900">Paystack Webhook</p>
                    <p className="text-xs text-gray-600 mt-1">Configure this in Paystack Dashboard → Settings → Webhooks</p>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => copyToClipboard(`${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/webhooks/paystack`)}
                    className="flex-shrink-0 ml-2"
                  >
                    {copiedUrl === `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/webhooks/paystack` ? (
                      <Check className="w-4 h-4" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </Button>
                </div>
                <div className="p-2 bg-white rounded border border-purple-200">
                  <p className="text-xs text-gray-700 font-mono break-all">{`${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/webhooks/paystack`}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bell className="w-5 h-5 text-blue-600" />
              Login Announcement
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="flex-1">
                <p className="font-medium text-gray-900">Enable Announcement</p>
                <p className="text-sm text-gray-600">Show a modal to users upon sign in</p>
              </div>
              <Switch
                checked={announcementEnabled}
                onCheckedChange={setAnnouncementEnabled}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="announcementTitle" className="text-sm font-medium">
                Announcement Title
              </Label>
              <Input
                id="announcementTitle"
                type="text"
                placeholder="Important Announcement"
                value={announcementTitle}
                onChange={(e) => setAnnouncementTitle(e.target.value)}
                className="w-full"
                disabled={!announcementEnabled}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="announcementMessage" className="text-sm font-medium">
                Announcement Message
              </Label>
              <Textarea
                id="announcementMessage"
                placeholder="Enter your announcement message here..."
                value={announcementMessage}
                onChange={(e) => setAnnouncementMessage(e.target.value)}
                className="w-full min-h-[120px] resize-y"
                disabled={!announcementEnabled}
              />
            </div>

            {announcementEnabled && announcementTitle && announcementMessage && (
              <div className="p-3 sm:p-4 bg-green-50 border border-green-200 rounded-lg">
                <p className="text-xs sm:text-sm text-green-700">
                  <span className="font-semibold">✓ Active:</span> This announcement will be shown to users upon sign in.
                </p>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-3 pt-4">
              <Button
                onClick={handleSave}
                disabled={saving}
                className="w-full sm:w-auto flex items-center justify-center gap-2 bg-violet-600 hover:bg-violet-700"
              >
                {saving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    Save Settings
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Phone Blacklist Management */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bell className="w-5 h-5 text-red-600" />
              Phone Number Blacklist
            </CardTitle>
          </CardHeader>
          <CardContent>
            <PhoneBlacklistManager />
          </CardContent>
        </Card>

        {/* Christmas Theme Settings */}
        <Card className="mt-6 border-2 border-red-500">
          <CardHeader className="bg-gradient-to-r from-red-50 to-green-50">
            <CardTitle className="flex items-center gap-2 text-2xl">
              🎄 Christmas Theme 🎅
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pt-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-6 bg-red-50 border-2 border-red-300 rounded-lg">
              <div className="flex-1">
                <p className="font-bold text-gray-900 text-lg">Enable Christmas Theme</p>
                <p className="text-sm text-gray-700 mt-2">
                  {christmasThemeEnabled
                    ? "✨ Christmas theme is currently ACTIVE! The app features festive colors, snowfall effects, and holiday decorations."
                    : "Add festive holiday spirit to the app with Christmas-themed colors, animations, and decorations."}
                </p>
              </div>
              <div className="flex items-center justify-end gap-4 min-w-fit">
                <span className="text-sm font-medium text-gray-700">
                  {christmasThemeEnabled ? "ON" : "OFF"}
                </span>
                <Switch
                  checked={christmasThemeEnabled}
                  onCheckedChange={handleChristmasThemeToggle}
                  disabled={savingChristmasTheme}
                />
                {savingChristmasTheme && (
                  <Loader2 className="h-5 w-5 animate-spin text-red-600" />
                )}
              </div>
            </div>

            <div className="p-4 bg-gradient-to-r from-red-100 to-green-100 border-2 border-green-400 rounded-lg">
              <p className="text-sm font-medium text-green-900">
                <span className="font-bold">🎁 Theme Features:</span> Red and green color scheme, snowfall animation, Christmas decorations (🎄 🎅 ⛄ 🎁 ❄️), festive button effects, and more!
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Settings Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-gray-700">
            <p>
              The join community link will be available to:
            </p>
            <ul className="list-disc list-inside space-y-2 ml-2">
              <li>Users viewing their dashboard</li>
              <li>Users in the sidebar or header</li>
              <li>Public pages (if configured)</li>
            </ul>
            <p className="text-gray-600 mt-4">
              Changes are saved immediately and reflected across the application.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
