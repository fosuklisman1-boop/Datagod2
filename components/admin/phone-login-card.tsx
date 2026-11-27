"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { Loader2, Smartphone } from "lucide-react"

type Settings = { enabled: boolean; newDeviceCode: boolean }
type Counts = {
  login_ok: number
  login_unchallenged: number
  challenge_sent: number
  challenge_passed: number
  lockout: number
}

const COUNT_LABELS: Array<[keyof Counts, string]> = [
  ["login_ok", "Logins"],
  ["login_unchallenged", "Logins without a code"],
  ["challenge_sent", "Codes sent"],
  ["challenge_passed", "Codes passed"],
  ["lockout", "Lockouts"],
]

export function PhoneLoginCard() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [counts, setCounts] = useState<Counts | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const headers = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return {
      Authorization: `Bearer ${session?.access_token || ""}`,
      "Content-Type": "application/json",
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/admin/phone-login", { headers: await headers() })
      if (!res.ok) throw new Error("load failed")
      const data = await res.json()
      setSettings(data.settings)
      setCounts(data.last24h)
    } catch {
      toast.error("Failed to load phone login settings")
    } finally {
      setLoading(false)
    }
  }, [headers])

  useEffect(() => {
    load()
  }, [load])

  async function save(next: Settings) {
    if (!settings) return
    if (settings.newDeviceCode && !next.newDeviceCode) {
      const ok = window.confirm(
        "Turning the new-device SMS code OFF weakens protection: anyone with a customer's phone number and password can sign in from a new browser without a code. Turn it off?",
      )
      if (!ok) return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/admin/phone-login", {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify(next),
      })
      if (!res.ok) throw new Error("save failed")
      const data = await res.json()
      setSettings(data.settings)
      toast.success("Phone login settings saved")
    } catch {
      toast.error("Failed to save phone login settings")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Smartphone className="w-4 h-4 text-primary" /> Phone login
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {loading || !settings ? (
          <div className="flex justify-center p-6"><Loader2 className="w-5 h-5 animate-spin" /></div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-4">
              <label className="flex items-center justify-between gap-4">
                <span className="text-sm font-medium">Phone login</span>
                <Switch
                  checked={settings.enabled}
                  disabled={saving}
                  onCheckedChange={(v) => save({ ...settings, enabled: v })}
                  aria-label="Phone login"
                />
              </label>
              <label className="flex items-center justify-between gap-4">
                <span className="text-sm font-medium">New-device SMS code</span>
                <Switch
                  checked={settings.newDeviceCode}
                  disabled={saving}
                  onCheckedChange={(v) => save({ ...settings, newDeviceCode: v })}
                  aria-label="New-device SMS code"
                />
              </label>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-2">Last 24 hours</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                {COUNT_LABELS.map(([k, label]) => (
                  <div key={k} className="rounded-md border p-3">
                    <div className="text-xl font-semibold text-primary">{counts?.[k] ?? 0}</div>
                    <div className="text-xs text-muted-foreground">{label}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
