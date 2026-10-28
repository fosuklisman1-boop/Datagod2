"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
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
  const [shop, setShop] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        const token = await getToken()
        const res = await fetch("/api/admin/settings/public-ussd-codes", { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) {
          const { codes } = await res.json()
          setMain(codes?.main ?? "")
          setShop(codes?.shop ?? null)
          setLoaded(true)
        } else {
          toast.error("Failed to load public USSD code")
        }
      } catch {
        toast.error("Failed to load public USSD code")
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
        body: JSON.stringify({ main }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error || "Failed to save USSD code")
        return
      }
      setMain(data.codes?.main ?? "")
      toast.success("Public USSD code saved")
    } catch {
      toast.error("Failed to save USSD code")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="mb-6 border-border">
      <CardHeader>
        <CardTitle>Public USSD code (shown on website)</CardTitle>
        <CardDescription>
          Leave empty to hide the USSD page. The shop dial code, where customers then enter a seller&apos;s 4-digit
          shop code, is set on{" "}
          <Link href="/admin/ussd-shops" className="underline">
            USSD Shops
          </Link>
          .
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
                <Label>Shop dial code (from USSD Shops)</Label>
                <p className="text-sm font-mono py-2">{shop ?? "Not set"}</p>
              </div>
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
