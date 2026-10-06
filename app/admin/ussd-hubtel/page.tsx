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

type TxFilter = "all" | "attention" | "awaiting_payment" | "fulfilled" | "failed"
const TX_FILTERS: { value: TxFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "attention", label: "Needs attention" },
  { value: "awaiting_payment", label: "Awaiting payment" },
  { value: "fulfilled", label: "Fulfilled" },
  { value: "failed", label: "Failed" },
]

function matchesFilter(t: HubtelTxRow, f: TxFilter): boolean {
  if (f === "all") return true
  if (f === "attention") return t.state === "needs_review" || t.callback_status === "failed"
  return t.state === f
}

/** Short id with the full value on hover; click copies the full value. */
function IdCell({ value, label }: { value: string | null; label: string }) {
  if (!value) return <span className="text-muted-foreground">-</span>
  const short = value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
  return (
    <button
      type="button"
      title={`${value} (click to copy)`}
      aria-label={`Copy ${label} ${value}`}
      className="font-mono text-xs underline decoration-dotted underline-offset-2 hover:text-foreground"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => toast.success(`${label} copied`), () => toast.error("Copy failed"))
      }}
    >
      {short}
    </button>
  )
}

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
  const [filter, setFilter] = useState<TxFilter>("all")
  const shown = txs.filter(t => matchesFilter(t, filter))

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
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>Payments</CardTitle>
              {counts && <CardDescription>
                {counts.awaiting_payment} awaiting · {counts.needs_review} need review · {counts.callback_pending} callbacks pending · {counts.callback_failed} callbacks failed
              </CardDescription>}
              <CardDescription className="mt-1 text-xs">
                Shows the 50 most recent sessions plus every row needing attention (needs review or callback failed).
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Select value={filter} onValueChange={v => setFilter(v as TxFilter)}>
                <SelectTrigger className="w-44" aria-label="Filter by state"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TX_FILTERS.map(f => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={load} aria-label="Refresh"><RefreshCw className="w-4 h-4" /></Button>
            </div>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-muted-foreground">
                <th className="p-2">Time</th><th className="p-2">Session</th><th className="p-2">Order</th><th className="p-2">Hubtel order</th>
                <th className="p-2">Platform</th><th className="p-2">Mobile</th><th className="p-2">Expected</th>
                <th className="p-2">Paid</th><th className="p-2">State</th><th className="p-2">Callback</th><th className="p-2" />
              </tr></thead>
              <tbody>
                {shown.map(t => (
                  <tr key={t.session_id} className="border-t">
                    <td className="p-2 whitespace-nowrap">{new Date(t.created_at).toLocaleString()}</td>
                    <td className="p-2"><IdCell value={t.session_id} label="Session id" /></td>
                    <td className="p-2">
                      <div className="text-xs text-muted-foreground">{t.order_table}</div>
                      <IdCell value={t.order_id} label="Order id" />
                    </td>
                    <td className="p-2"><IdCell value={t.hubtel_order_id} label="Hubtel order id" /></td>
                    <td className="p-2">{t.platform}</td>
                    <td className="p-2 whitespace-nowrap">{t.mobile ?? "-"}</td>
                    <td className="p-2">GHS {Number(t.expected_amount).toFixed(2)}</td>
                    <td className="p-2">{t.amount_after_charges != null ? `GHS ${Number(t.amount_after_charges).toFixed(2)}` : "-"}</td>
                    <td className="p-2">
                      <Badge variant={t.state === "needs_review" || t.state === "failed" ? "destructive" : "secondary"}>{t.state}</Badge>
                      {t.state === "needs_review" && t.callback_last_error && (
                        <div className="mt-1 max-w-[16rem] text-xs text-muted-foreground">{t.callback_last_error}</div>
                      )}
                    </td>
                    <td className="p-2" title={t.callback_last_error ?? ""}><Badge variant={t.callback_status === "failed" ? "destructive" : "outline"}>{t.callback_status}</Badge></td>
                    <td className="p-2">
                      {(t.state === "fulfilled" || t.state === "needs_review") && (t.callback_status === "pending" || t.callback_status === "failed") && (
                        <Button size="sm" variant="outline" disabled={busy === t.session_id} onClick={() => retry(t.session_id)}>Retry callback</Button>
                      )}
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr><td colSpan={11} className="p-6 text-center text-muted-foreground">
                    {txs.length === 0 ? "No Hubtel transactions yet." : "No transactions match this filter."}
                  </td></tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
