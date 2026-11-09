"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, Save } from "lucide-react"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"

async function getToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token ?? ""
}

export default function GoogleReviewUrlCard() {
  const [url, setUrl] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        const token = await getToken()
        const res = await fetch("/api/admin/settings/google-review-url", { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) {
          const data = await res.json()
          setUrl(data.url ?? "")
          setLoaded(true)
        } else {
          toast.error("Failed to load Google review link")
        }
      } catch {
        toast.error("Failed to load Google review link")
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      const token = await getToken()
      const res = await fetch("/api/admin/settings/google-review-url", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ url }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error || "Failed to save Google review link")
        return
      }
      setUrl(data.url ?? "")
      toast.success(data.url ? "Google review link saved" : "Google review card turned off")
    } catch {
      toast.error("Failed to save Google review link")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="mb-6 border-border">
      <CardHeader>
        <CardTitle>Google review link</CardTitle>
        <CardDescription>
          On Google, search your business name while signed in to the Google account that manages the profile → in the
          Business Profile panel choose &quot;Ask for reviews&quot; (or &quot;Get more reviews&quot;) → copy the review link → paste here.
          Leave empty to hide the review card on customer dashboards.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="google-review-url">Review link</Label>
              <Input
                id="google-review-url"
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="https://g.page/r/.../review"
                maxLength={500}
              />
            </div>
            <Button onClick={save} disabled={saving || !loaded}>
              {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Save
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  )
}
