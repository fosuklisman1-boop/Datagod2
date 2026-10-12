"use client"
import { useState } from "react"
import { Loader2, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { api, type SettingsData } from "../_lib/api"
import { useLoad } from "../_lib/useLoad"
import { formatGhs, formatGmt, toneClass } from "../_lib/view"
import { Switch } from "@/components/ui/switch"
import {
  balanceSourceSummary, MANUAL_BALANCE_NOTES, parseManualBalanceInput, PREFER_MANUAL_CONFIRM, PREFER_MANUAL_HELP, PREFER_MANUAL_LABEL,
  relayInfoText, SET_BALANCE_CONFIRM_NOTE, type HubtelBalanceData,
} from "../_lib/hubtel-balance-view"
import { ConfirmDialog, ErrorBox } from "./ui-bits"

type Saved = (data: SettingsData | null) => void | Promise<void>

/**
 * Settings → "Hubtel balance (manual fallback)". The admin enters the Hubtel SMS balance; the server
 * stamps when/who and the solvency gate uses amount − Hubtel spend recorded since then — as a fallback
 * when the relay /balance fails, or always when "prefer manual" is on (the relay reads the Disbursement
 * wallet, not the SMS wallet; its reading is then shown for information only).
 */
export function HubtelBalanceSection({ onSaved }: { onSaved: Saved }) {
  const { data, error, loading, reload } = useLoad<HubtelBalanceData>(
    () => api<HubtelBalanceData>("/api/admin/sms-platform/hubtel-balance"), [])
  const [input, setInput] = useState("")
  const [dialog, setDialog] = useState<null | "set" | "clear" | "prefer-on">(null)
  const [busy, setBusy] = useState(false)
  const parsed = parseManualBalanceInput(input)

  const save = (amountGhs: number | null) =>
    patch({ amountGhs }, amountGhs === null ? "Manual balance cleared" : "Manual balance set", true)
  const setPrefer = (preferManual: boolean) =>
    patch({ preferManual }, preferManual ? "Manual balance now used instead of the relay" : "Relay balance used again (manual balance only as fallback)", false)

  async function patch(values: Record<string, unknown>, okText: string, clearInput: boolean) {
    if (busy) return
    setBusy(true)
    try {
      const res = await api<SettingsData | null>("/api/admin/sms-platform/settings", {
        method: "PATCH", body: JSON.stringify({ section: "hubtel_manual_balance", values }),
      })
      if (res.success) {
        toast.success(okText)
        setDialog(null)
        if (clearInput) setInput("")
        await onSaved(res.data ?? null)
      } else toast.error(res.error ?? "Could not save")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save")
    } finally {
      setBusy(false)
    }
  }

  const cur = data?.current
  const summary = cur ? balanceSourceSummary(cur) : null
  const manual = data?.manual ?? null
  const prefer = data?.preferManual === true

  return (
    <Card className="clay min-w-0 border-0 py-0">
      <CardHeader className="pb-2 pt-4">
        <CardTitle className="text-base">Hubtel balance (manual fallback)</CardTitle>
        <CardDescription>
          Enter the Hubtel SMS balance shown in the Hubtel dashboard; the app subtracts the Hubtel SMS it records from then on.
          By default it is used only while the relay balance check is failing; switch on the option below to use it instead of the relay.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pb-4">
        <div className="clay-inset space-y-1.5 rounded-2xl px-4 py-3 text-sm">
          {loading && !data ? (
            <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" />Checking the Hubtel balance…</p>
          ) : error && !data ? (
            <ErrorBox message={error} onRetry={() => void reload()} />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">Balance in use:</span>
                {summary && <Badge variant="outline" className={`${toneClass(summary.tone)} max-w-full whitespace-normal break-words text-left`}>{summary.label}</Badge>}
                {cur?.ok && <span className="font-semibold tabular-nums">{formatGhs(cur.amountGhs)}</span>}
                <Button variant="ghost" size="sm" className="ml-auto h-7 px-2" disabled={loading} onClick={() => void reload()} aria-label="Refresh balance">
                  <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
                </Button>
              </div>
              {manual ? (
                <p className="text-muted-foreground">
                  Manual balance: <span className="font-medium text-foreground">{formatGhs(manual.amountGhs)}</span>, set {formatGmt(manual.setAt)}
                  {!manual.fresh && <span className="text-amber-700 dark:text-amber-300"> — older than 30 days, ignored. Set it again.</span>}
                </p>
              ) : (
                <p className="text-muted-foreground">No manual balance set.</p>
              )}
              {data?.relay && (
                <p className="text-muted-foreground">
                  {relayInfoText(data.relay)}{prefer && data.relay.ok && <> (information only — not used)</>}
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex items-start gap-3">
          <Switch id="hubtel-prefer-manual" checked={prefer} disabled={busy || !data}
            onCheckedChange={(on) => { if (on) setDialog("prefer-on"); else void setPrefer(false) }} className="mt-0.5" />
          <label htmlFor="hubtel-prefer-manual" className="min-w-0 space-y-1">
            <span className="block text-sm font-medium">{PREFER_MANUAL_LABEL}</span>
            <span className="block text-xs text-muted-foreground">{PREFER_MANUAL_HELP}</span>
          </label>
        </div>

        <label className="block min-w-0 space-y-1">
          <span className="text-sm font-medium">Current Hubtel Disbursement balance (GH₵)</span>
          <Input inputMode="decimal" placeholder="e.g. 250.00" value={input} onChange={(e) => setInput(e.target.value)} />
          {input.trim() !== "" && !parsed.ok && <span className="block text-xs text-red-600">{parsed.error}</span>}
        </label>

        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {MANUAL_BALANCE_NOTES.map((n) => <li key={n}>{n}</li>)}
        </ul>

        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={busy || !parsed.ok} onClick={() => setDialog("set")}>Set balance now</Button>
          {manual && <Button size="sm" variant="outline" disabled={busy} onClick={() => setDialog("clear")}>Clear manual balance</Button>}
        </div>
      </CardContent>

      <ConfirmDialog open={dialog === "set"} onOpenChange={(o) => !o && setDialog(null)} busy={busy}
        title="Set the Hubtel balance" confirmLabel="Set balance now"
        description={<>Credit sales will be backed by <b>{parsed.ok ? formatGhs(parsed.value) : "—"}</b> minus the Hubtel SMS sent from now on, until the live balance check works again.<br /><br />{SET_BALANCE_CONFIRM_NOTE}</>}
        onConfirm={() => { if (parsed.ok) return save(parsed.value) }} />
      <ConfirmDialog open={dialog === "prefer-on"} onOpenChange={(o) => !o && setDialog(null)} busy={busy}
        title="Use the manual balance instead of the relay?" confirmLabel="Use manual balance"
        description={<>{PREFER_MANUAL_CONFIRM}{data?.relay && <><br /><br />{relayInfoText(data.relay)}.</>}{manual
          ? <> Your manual balance: <b>{formatGhs(manual.amountGhs)}</b>, set {formatGmt(manual.setAt)}{!manual.fresh && " — older than 30 days, so sales would pause until you set it again"}.</>
          : <> No manual balance is set yet, so sales would pause until you set one.</>}</>}
        onConfirm={() => setPrefer(true)} />
      <ConfirmDialog open={dialog === "clear"} onOpenChange={(o) => !o && setDialog(null)} busy={busy} destructive
        title="Clear the manual balance" confirmLabel="Clear"
        description="Without a manual balance, SMS credit sales pause whenever the live Hubtel balance check fails."
        onConfirm={() => save(null)} />
    </Card>
  )
}
