"use client"

// WhatsApp bots (main + shop): the commission-cashback switches "Network Plans", "Pay Bills" and "Cashback airtime"
// (admin_settings `whatsapp_cashback_visibility`, read with `=== true` only). Saved through the validated admin route
// /api/admin/whatsapp/cashback-visibility. An item is live only when its switch AND the shared cashback Bots gate
// (Hubtel commission > Cashback: Bots surface + "Sell on bots" for its group) are on.
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Loader2, MessageSquare } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { supabase } from "@/lib/supabase"
import {
  parseWaCashbackState, waCashbackStatus, WA_CASHBACK_API, WA_CASHBACK_SWITCHES, type WaCashbackState, type WaCashbackSwitchKey,
} from "@/lib/whatsapp-bot/cashback-visibility-admin"

const STATUS: Record<"live" | "waiting" | "off", { text: string; className: string }> = {
  live: { text: "Live", className: "bg-primary text-primary-foreground" },
  waiting: {
    text: "Waiting for the cashback Bots switch",
    className: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  },
  off: { text: "Off", className: "bg-muted text-muted-foreground" },
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession()
  return { Authorization: `Bearer ${session?.access_token}` }
}

export function WhatsAppCashbackSwitches({ initial }: { initial?: WaCashbackState }) {
  const [state, setState] = useState<WaCashbackState | null>(initial ?? null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<WaCashbackSwitchKey | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(WA_CASHBACK_API, { headers: await authHeaders() })
      const parsed = res.ok ? parseWaCashbackState(await res.json()) : null
      if (!parsed) throw new Error("bad answer")
      setState(parsed)
      setError(null)
    } catch {
      setError("Could not load the WhatsApp cashback switches.")
    }
  }, [])

  useEffect(() => {
    if (!initial) void load()
  }, [initial, load])

  async function toggle(key: WaCashbackSwitchKey, label: string, on: boolean) {
    if (on && !window.confirm(`Turn on ${label} on BOTH WhatsApp bots? Customers see it right away when the cashback Bots switch is on.`)) return
    setBusy(key)
    try {
      const res = await fetch(WA_CASHBACK_API, {
        method: "POST",
        headers: { ...(await authHeaders()), "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: on }),
      })
      const parsed = res.ok ? parseWaCashbackState(await res.json()) : null
      if (!parsed) throw new Error("save failed")
      setState(parsed)
      toast.success(`${label} (WhatsApp) ${on ? "on" : "off"}`)
    } catch {
      toast.error(`Could not save ${label} (WhatsApp). Nothing changed.`)
      void load()
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="border-primary/20">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <MessageSquare className="h-4 w-4" />
          </span>
          WhatsApp bot settings
        </CardTitle>
        <CardDescription>
          Commission-cashback items on the main WhatsApp bot and the WhatsApp shop bot. Off unless switched on here; live
          only when the cashback Bots switch is also on.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!state && !error && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}
        {state && WA_CASHBACK_SWITCHES.map(({ key, label, hint }) => {
          const status = STATUS[waCashbackStatus(state, key)]
          return (
            <div key={key} className="flex items-start justify-between gap-3 rounded-lg border p-3">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">{label} <span className="text-muted-foreground">(WhatsApp)</span></div>
                <p className="text-xs text-muted-foreground">{hint}</p>
                <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${status.className}`}>{status.text}</span>
              </div>
              <div className="flex shrink-0 items-center gap-2 pt-0.5">
                {busy === key && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                <Switch
                  aria-label={`${label} (WhatsApp)`}
                  checked={state.switches[key]}
                  disabled={busy !== null}
                  onCheckedChange={v => void toggle(key, label, v)}
                />
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
