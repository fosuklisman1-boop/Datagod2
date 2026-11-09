"use client"

import { useEffect, useMemo, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2, Zap, Wallet, Link2, Copy, Tags } from "lucide-react"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"

type Mode = "normal" | "instant"
interface Plan { planCode: number; displayName: string; bundleSizeMb: number; unitPriceGhs: number }
interface PricingBody { plans?: Plan[] }

async function authed(path: string, init: RequestInit = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error("Authentication required")
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || res.statusText)
  return json
}

const fmt = (n: number | undefined) => (typeof n === "number" ? `₵${n.toFixed(2)}` : "—")

/** Kuntanii settings: delivery-mode toggle, live price table, webhook URL. */
export function KuntaniiCard() {
  const [mode, setMode] = useState<Mode | null>(null)
  const [saving, setSaving] = useState(false)
  const [pricing, setPricing] = useState<{ normal: PricingBody | null; instant: PricingBody | null } | null>(null)
  const [loading, setLoading] = useState(true)
  const [webhookUrl, setWebhookUrl] = useState("/api/webhooks/mtn/kuntanii")

  useEffect(() => {
    setWebhookUrl(`${window.location.origin}/api/webhooks/mtn/kuntanii`)
    let cancelled = false
    const load = async () => {
      try {
        const [settings, prices] = await Promise.all([
          authed("/api/admin/kuntanii?action=settings"),
          authed("/api/admin/kuntanii?action=pricing"),
        ])
        if (cancelled) return
        setMode(settings.mode === "instant" ? "instant" : "normal")
        setPricing({ normal: prices.normal ?? null, instant: prices.instant ?? null })
      } catch (e) {
        if (!cancelled) toast.error(e instanceof Error ? e.message : "Failed to load Kuntanii data")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [])

  const handleSetMode = async (next: Mode) => {
    if (next === mode) return
    setSaving(true)
    try {
      await authed("/api/admin/kuntanii", { method: "POST", body: JSON.stringify({ action: "set-delivery-mode", mode: next }) })
      setMode(next)
      toast.success(`Kuntanii delivery mode set to ${next}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update")
    } finally {
      setSaving(false)
    }
  }

  const rows = useMemo(() => {
    const byMb = new Map<number, { mb: number; normal?: number; instant?: number }>()
    for (const key of ["normal", "instant"] as const) {
      for (const p of pricing?.[key]?.plans ?? []) {
        const row = byMb.get(p.bundleSizeMb) ?? { mb: p.bundleSizeMb }
        row[key] = p.unitPriceGhs
        byMb.set(p.bundleSizeMb, row)
      }
    }
    return [...byMb.values()].sort((a, b) => a.mb - b.mb)
  }, [pricing])

  const copyWebhook = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl)
      toast.success("Webhook URL copied")
    } catch {
      toast.error("Could not copy")
    }
  }

  return (
    <div className="space-y-4 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Zap className="h-5 w-5" />Delivery Mode</CardTitle>
          <CardDescription>
            Instant must be enabled by Kuntanii; refused instant orders fail over to the next provider.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
          ) : (
            <div className="flex items-center gap-2">
              {(["normal", "instant"] as const).map(m => (
                <Button
                  key={m}
                  size="sm"
                  variant={mode === m ? "default" : "outline"}
                  disabled={saving || mode === null}
                  onClick={() => handleSetMode(m)}
                >
                  {m === "normal" ? "Normal" : "Instant"}
                </Button>
              ))}
              {saving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </div>
          )}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Wallet className="h-4 w-4" />Balance: n/a — credit account
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Link2 className="h-5 w-5" />Webhook</CardTitle>
          <CardDescription>Register this URL in the Kuntanii dashboard.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate rounded bg-muted px-2 py-1.5 text-xs">{webhookUrl}</code>
            <Button size="sm" variant="outline" onClick={copyWebhook} title="Copy webhook URL">
              <Copy className="h-3 w-3" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Tags className="h-5 w-5" />Live Prices</CardTitle>
          <CardDescription>Unit price per plan, fetched live from Kuntanii.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
          ) : rows.length === 0 ? (
            <Alert><AlertDescription className="text-xs">Pricing unavailable.</AlertDescription></Alert>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">GB</th>
                    <th className="py-2 pr-4 font-medium">Normal GHS</th>
                    <th className="py-2 font-medium">Instant GHS</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.mb} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-medium">{r.mb / 1024}</td>
                      <td className="py-2 pr-4">{pricing?.normal ? fmt(r.normal) : <span className="text-muted-foreground">unavailable</span>}</td>
                      <td className="py-2">{pricing?.instant ? fmt(r.instant) : <span className="text-muted-foreground">unavailable</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
