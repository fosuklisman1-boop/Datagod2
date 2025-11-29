"use client"

import { useEffect, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { useParams, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { toast } from "sonner"
import { Loader2, Save, MessageCircle } from "lucide-react"

export default function ShopSettingsPage() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const params = useParams()
  const shopId = params.shopId as string

  const [whatsappLink, setWhatsappLink] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [shopName, setShopName] = useState("")

  // Verify shop ownership and fetch settings
  useEffect(() => {
    if (!user || !shopId) return

    const fetchSettings = async () => {
      try {
        // First verify shop ownership
        const shopResponse = await fetch(`/api/shops/${shopId}`)
        const shopData = await shopResponse.json()

        if (!shopData || shopData.user_id !== user.id) {
          toast.error("You don't have permission to edit this shop")
          router.push("/dashboard/my-shop")
          return
        }

        setShopName(shopData.name || "")

        // Fetch settings
        const response = await fetch(`/api/shop/settings/${shopId}`)
        const data = await response.json()

        if (data.whatsapp_link) {
          setWhatsappLink(data.whatsapp_link)
        }
      } catch (error) {
        console.error("[SHOP-SETTINGS] Error fetching settings:", error)
        toast.error("Failed to load settings")
      } finally {
        setLoading(false)
      }
    }

    fetchSettings()
  }, [user, shopId, router])

  const handleSave = async () => {
    if (!whatsappLink.trim()) {
      toast.error("Please enter a WhatsApp link")
      return
    }

    // Validate URL
    try {
      new URL(whatsappLink)
    } catch {
      toast.error("Please enter a valid URL")
      return
    }

    setSaving(true)
    try {
      // Get session token
      const { data: { session } } = await (async () => {
        try {
          const response = await fetch("/api/auth/session")
          return response.json()
        } catch {
          return { data: { session: null } }
        }
      })()

      const response = await fetch(`/api/shop/settings/${shopId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token || ""}`,
        },
        body: JSON.stringify({
          whatsapp_link: whatsappLink,
        }),
      })

      const result = await response.json()

      if (!response.ok) {
        toast.error(result.error || "Failed to save settings")
        return
      }

      toast.success("WhatsApp link saved successfully!")
    } catch (error) {
      console.error("[SHOP-SETTINGS] Error saving settings:", error)
      toast.error("Failed to save settings")
    } finally {
      setSaving(false)
    }
  }

  if (authLoading || loading) {
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
          <h1 className="text-3xl font-bold text-gray-900">Shop Settings</h1>
          <p className="text-gray-600 mt-2">
            Configure {shopName ? `"${shopName}"` : "your shop"} settings
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageCircle className="w-5 h-5 text-green-600" />
              WhatsApp Link
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="whatsappLink" className="text-sm font-medium">
                WhatsApp Contact Link
              </Label>
              <p className="text-xs text-gray-500 mt-1 mb-2">
                This link will appear on your storefront so customers can contact you on WhatsApp
              </p>
              <Input
                id="whatsappLink"
                type="url"
                placeholder="https://wa.me/1234567890"
                value={whatsappLink}
                onChange={(e) => setWhatsappLink(e.target.value)}
                className="w-full"
              />
            </div>

            <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700">
              <p className="font-semibold mb-2">How to get your WhatsApp link:</p>
              <ol className="list-decimal list-inside space-y-1 text-xs">
                <li>Open WhatsApp and go to your profile</li>
                <li>Go to Settings → Business tools → Business links</li>
                <li>Create a new link or copy existing one</li>
                <li>Or use: https://wa.me/YOUR_PHONE_NUMBER (with country code)</li>
              </ol>
            </div>

            {whatsappLink && (
              <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                <p className="text-sm text-green-700">
                  <span className="font-semibold">Preview:</span>{" "}
                  <a
                    href={whatsappLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-green-600 hover:underline break-all"
                  >
                    {whatsappLink}
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
            <CardTitle>Where This Appears</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-gray-700">
            <p>Your WhatsApp link will be displayed:</p>
            <ul className="list-disc list-inside space-y-2 ml-2">
              <li>On your shop storefront (product pages)</li>
              <li>In the shop sidebar/header</li>
              <li>As a contact button for customers</li>
            </ul>
            <p className="text-gray-600 mt-4">
              Changes are saved immediately and reflected on your storefront.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
