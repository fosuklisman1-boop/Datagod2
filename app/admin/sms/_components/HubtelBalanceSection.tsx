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
import { balanceSourceSummary, MANUAL_BALANCE_NOTES, parseManualBalanceInput, SET_BALANCE_CONFIRM_NOTE, type HubtelBalanceData } from "../_lib/hubtel-balance-view"
import { ConfirmDialog, ErrorBox } from "./ui-bits"

type Saved = (data: SettingsData | null) => void | Promise<void>

/**
 * Settings → "Hubtel balance (manual fallback)". While the relay /balance is blocked, the admin enters
 * the Disbursement balance shown in the Hubtel dashboard; the server stamps when/who and the solvency
 * gate uses amount − Hubtel spend recorded since then. The live relay balance always wins when it works.
 */
export function HubtelBalanceSection({ onSaved }: { onSaved: Saved }) {
  const { data, error, loading, reload } = useLoad<HubtelBalanceData>(
    () => api<HubtelBalanceData>("/api/admin/sms-platform/hubtel-balance"), [])
  const [input, setInput] = useState("")
  const [dialog, setDialog] = useState<null | "set" | "clear">(null)
  const [busy, setBusy] = useState(false)
  const parsed = parseManualBalanceInput(input)

  async function save(amountGhs: number | null) {
    if (busy) return
    setBusy(true)
    try {
      const res = await api<SettingsData | null>("/api/admin/sms-platform/settings", {
        method: "PATCH", body: JSON.stringify({ section: "hubtel_manual_balance", values: { amountGhs } }),
      })
      if (res.success) {
        toast.success(amountGhs === null ? "Manual balance cleared" : "Manual balance set")
        setDialog(null); setInput("")
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

  return (
    <Card className="clay min-w-0 border-0 py-0">
      <CardHeader className="pb-2 pt-4">
        <CardTitle className="text-base">Hubtel balance (manual fallback)</CardTitle>
        <CardDescription>
          Used only while the live Hubtel balance check (relay /balance) is failing. Enter the Disbursement balance shown in
          the Hubtel dashboard; the app subtracts the Hubtel SMS it records from then on. The live balance always wins when it works.
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
            </>
          )}
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
      <ConfirmDialog open={dialog === "clear"} onOpenChange={(o) => !o && setDialog(null)} busy={busy} destructive
        title="Clear the manual balance" confirmLabel="Clear"
        description="Without a manual balance, SMS credit sales pause whenever the live Hubtel balance check fails."
        onConfirm={() => save(null)} />
    </Card>
  )
}
