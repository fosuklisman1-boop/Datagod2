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

export default function PublicUssdCodesCard() {
  const [main, setMain] = useState("")
  const [shop, setShop] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        const token = await getToken()
        const res = await fetch("/api/admin/settings/public-ussd-codes", { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) {
          const { codes } = await res.json()
          setMain(codes?.main ?? "")
          setShop(codes?.shop ?? "")
        } else {
          toast.error("Failed to load public USSD codes")
        }
      } catch {
        toast.error("Failed to load public USSD codes")
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      const token = await getToken()
      const res = await fetch("/api/admin/settings/public-ussd-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ main, shop }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error || "Failed to save USSD codes")
        return
      }
      setMain(data.codes?.main ?? "")
      setShop(data.codes?.shop ?? "")
      toast.success("Public USSD codes saved")
    } catch {
      toast.error("Failed to save USSD codes")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Public USSD codes (shown on website)</CardTitle>
        <CardDescription>
          Leave empty to hide. Use SHOPCODE where each shop&apos;s own code goes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="public-ussd-main">Main USSD code</Label>
                <Input id="public-ussd-main" value={main} onChange={e => setMain(e.target.value)} placeholder="*920#" maxLength={30} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="public-ussd-shop">Shop code format</Label>
                <Input id="public-ussd-shop" value={shop} onChange={e => setShop(e.target.value)} placeholder="*920*SHOPCODE#" maxLength={30} />
              </div>
            </div>
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Save
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  )
}
