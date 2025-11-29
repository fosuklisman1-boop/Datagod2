"use client"

import { useEffect, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { toast } from "sonner"
import { Loader2, Save, ExternalLink } from "lucide-react"

export default function AdminSettingsPage() {
  const { user, isAdmin, loading: authLoading } = useAuth()
  const router = useRouter()
  const [joinCommunityLink, setJoinCommunityLink] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Redirect if not admin
  useEffect(() => {
    if (!authLoading && (!user || !isAdmin)) {
      router.push("/auth/login")
      return
    }
  }, [user, isAdmin, authLoading, router])

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
      } catch (error) {
        console.error("[SETTINGS] Error fetching settings:", error)
        toast.error("Failed to load settings")
      } finally {
        setLoading(false)
      }
    }

    fetchSettings()
  }, [user])

  const handleSave = async () => {
    if (!joinCommunityLink.trim()) {
      toast.error("Please enter a join community link")
      return
    }

    // Validate URL
    try {
      new URL(joinCommunityLink)
    } catch {
      toast.error("Please enter a valid URL")
      return
    }

    setSaving(true)
    try {
      const { data: { session } } = await (async () => {
        // Get session from Supabase
        const response = await fetch("/api/auth/session")
        return response.json()
      })().catch(() => ({ data: { session: null } }))

      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token || ""}`,
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

      toast.success("Settings saved successfully!")
    } catch (error) {
      console.error("[SETTINGS] Error saving settings:", error)
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
