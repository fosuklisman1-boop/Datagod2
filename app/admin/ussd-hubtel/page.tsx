"use client"

import { useCallback, useEffect, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { PageHeaderBanner } from "@/components/shared/page-header-banner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { RefreshCw } from "lucide-react"
import type { HubtelUssdConfig } from "@/lib/ussd-hubtel/config"
import type { HubtelTxRow } from "@/lib/ussd-hubtel/types"

type EnvStatus = { webhookSecret: boolean; relayUrl: boolean; relaySecret: boolean }
type Counts = { needs_review: number; callback_pending: number; callback_failed: number; awaiting_payment: number }

const SERVICES: { key: keyof HubtelUssdConfig["visibility"]; label: string; live: boolean }[] = [
  { key: "data", label: "Data Bundle", live: true },
  { key: "afa", label: "AFA Registration", live: false },
  { key: "airtime", label: "Buy Airtime", live: false },
  { key: "resultsChecker", label: "Results Checker", live: false },
]

async function authed(path: string, init?: RequestInit) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error("No authentication token available")
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || res.statusText || "Request failed")
  return json
}

export default function AdminUssdHubtelPage() {
  const [config, setConfig] = useState<HubtelUssdConfig | null>(null)
  const [env, setEnv] = useState<EnvStatus | null>(null)
  const [txs, setTxs] = useState<HubtelTxRow[]>([])
  const [counts, setCounts] = useState<Counts | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [c, t] = await Promise.all([authed("/api/admin/ussd-hubtel/config"), authed("/api/admin/ussd-hubtel/transactions")])
      setConfig(c.config); setEnv(c.env); setTxs(t.transactions); setCounts(t.counts)
    } catch (e: any) { toast.error(e.message || "Failed to load Hubtel USSD") }
  }, [])
  useEffect(() => { load() }, [load])

  const save = async (patch: object, label: string) => {
    setBusy(label)
    try {
      const res = await authed("/api/admin/ussd-hubtel/config", { method: "POST", body: JSON.stringify(patch) })
      setConfig(res.config); toast.success("Saved")
    } catch (e: any) { toast.error(e.message || "Save failed") } finally { setBusy(null) }
  }

  const retry = async (sessionId: string) => {
    setBusy(sessionId)
    try {
      const res = await authed("/api/admin/ussd-hubtel/retry-callback", { method: "POST", body: JSON.stringify({ sessionId }) })
      toast.success(`Callback: ${res.result}`); await load()
    } catch (e: any) { toast.error(e.message || "Retry failed") } finally { setBusy(null) }
  }

  const envOk = env && env.webhookSecret && env.relayUrl && env.relaySecret

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeaderBanner title="Hubtel USSD" subtitle="One Hubtel code serving the main menu. Configure the channel and watch payments." />

        <Card>
          <CardHeader>
            <CardTitle>Channel</CardTitle>
            <CardDescription>The kill switch ships OFF. Turn it on only after the runbook checks pass.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!config ? <p className="text-sm text-muted-foreground">Loading...</p> : (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Hubtel USSD enabled</span>
                  <Switch checked={config.enabled} disabled={busy === "enabled" || (!config.enabled && !envOk)} aria-label="Toggle Hubtel USSD"
                    onCheckedChange={v => save({ enabled: v }, "enabled")} />
                </div>
                {!envOk && <p className="text-xs text-amber-600">Cannot enable until all environment variables below are configured.</p>}
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Mode</span>
                  <Select value={config.mode} onValueChange={v => save({ mode: v }, "mode")}>
                    <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="main">Main USSD</SelectItem>
                      <SelectItem value="shop" disabled>Shop USSD (coming soon)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="divide-y rounded-lg border">
                  {SERVICES.map(s => (
                    <div key={s.key} className="flex items-center justify-between p-3">
                      <span className="text-sm">{s.label}{!s.live && <Badge variant="outline" className="ml-2">not built yet</Badge>}</span>
                      <Switch checked={config.visibility[s.key]} disabled={busy === s.key} aria-label={`Toggle ${s.label}`}
                        onCheckedChange={v => save({ visibility: { [s.key]: v } }, s.key)} />
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Environment</CardTitle><CardDescription>Secrets live in env vars; this only shows whether they are set.</CardDescription></CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {env && ([["HUBTEL_WEBHOOK_SECRET", env.webhookSecret], ["HUBTEL_RELAY_URL", env.relayUrl], ["HUBTEL_RELAY_SECRET", env.relaySecret]] as const).map(([k, ok]) => (
              <Badge key={k} variant={ok ? "default" : "destructive"}>{k}: {ok ? "set" : "missing"}</Badge>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Payments</CardTitle>
              {counts && <CardDescription>
                {counts.awaiting_payment} awaiting · {counts.needs_review} need review · {counts.callback_pending} callbacks pending · {counts.callback_failed} callbacks failed
              </CardDescription>}
            </div>
            <Button variant="outline" size="sm" onClick={load} aria-label="Refresh"><RefreshCw className="w-4 h-4" /></Button>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-muted-foreground">
                <th className="p-2">Time</th><th className="p-2">Platform</th><th className="p-2">Mobile</th><th className="p-2">Expected</th>
                <th className="p-2">Paid</th><th className="p-2">State</th><th className="p-2">Callback</th><th className="p-2" />
              </tr></thead>
              <tbody>
                {txs.map(t => (
                  <tr key={t.session_id} className="border-t">
                    <td className="p-2">{new Date(t.created_at).toLocaleString()}</td>
                    <td className="p-2">{t.platform}</td>
                    <td className="p-2">{t.mobile}</td>
                    <td className="p-2">GHS {Number(t.expected_amount).toFixed(2)}</td>
                    <td className="p-2">{t.amount_after_charges != null ? `GHS ${Number(t.amount_after_charges).toFixed(2)}` : "-"}</td>
                    <td className="p-2"><Badge variant={t.state === "needs_review" || t.state === "failed" ? "destructive" : "secondary"}>{t.state}</Badge></td>
                    <td className="p-2" title={t.callback_last_error ?? ""}><Badge variant={t.callback_status === "failed" ? "destructive" : "outline"}>{t.callback_status}</Badge></td>
                    <td className="p-2">
                      {(t.state === "fulfilled" || t.state === "needs_review") && (t.callback_status === "pending" || t.callback_status === "failed") && (
                        <Button size="sm" variant="outline" disabled={busy === t.session_id} onClick={() => retry(t.session_id)}>Retry callback</Button>
                      )}
                    </td>
                  </tr>
                ))}
                {txs.length === 0 && <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">No Hubtel transactions yet.</td></tr>}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
