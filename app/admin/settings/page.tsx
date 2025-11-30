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
import { Loader2, Save, ExternalLink, MessageCircle, Copy, Check, Link as LinkIcon } from "lucide-react"
import { supportSettingsService } from "@/lib/support-settings-service"

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
      } catch (error) {
        console.error("[SETTINGS] Error fetching settings:", error)
        toast.error("Failed to load settings")
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
      toast.error("Failed to save settings")
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
              <LinkIcon className="w-5 h-5 text-blue-600" />
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
