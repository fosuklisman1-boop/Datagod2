"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { adminFetch, ApiError, TTB_API, type OverviewResponse } from "./api"
import { funnelSteps, isQuiet, readSplit, relativeTime, smsCostText, ttbErrorMessage } from "./format"

export function OverviewTab({ data, error, onChanged }: { data: OverviewResponse | null; error: string | null; onChanged: () => void }) {
  const [pending, setPending] = useState<boolean | null>(null) // the value the admin asked for, while the confirm dialog is open
  const [busy, setBusy] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)

  if (!data) {
    return error ? <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p> : <p className="text-sm text-muted-foreground">Loading...</p>
  }

  const now = new Date()
  const main = data.overview.main
  const quiet = isQuiet(main.lastHeardAt, now, data.settings.quietAlertMinutes)
  const unreadable = data.settingsDefaulted
  const serviceRows = [
    { key: "data", label: "Data", on: data.settings.mainEnabled },
    { key: "airtime", label: "Airtime", on: data.settings.airtimeEnabled },
    { key: "results_checker", label: "Checkers", on: data.settings.resultsCheckerEnabled },
  ] as const

  async function apply(value: boolean) {
    setBusy(true)
    setDialogError(null)
    try {
      await adminFetch(TTB_API, { method: "PUT", body: value ? { mainEnabled: true, confirm: true } : { mainEnabled: false } })
      setPending(null)
      toast.success(value ? "Text-to-Buy is on" : "Text-to-Buy is off")
      onChanged()
    } catch (e) {
      setDialogError(ttbErrorMessage(e instanceof ApiError ? e.code : undefined))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      {unreadable && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm font-medium text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300" role="alert">
          The saved settings could not be read, so the values below are defaults and changes are disabled. Refresh to try again.
        </div>
      )}
      {!main.enabled && (
        <div className="rounded-md border bg-muted/50 p-3 text-sm">Text-to-Buy is switched off. Texts to this number are handled exactly as before.</div>
      )}
      {main.enabled && quiet && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200" role="alert">
          The forwarding phone has not been heard from {main.lastHeardAt ? `since ${relativeTime(main.lastHeardAt, now)}` : "yet"}. Customer texts may not be arriving.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-base">Main line</CardTitle>
              <div className="flex items-center gap-2">
                <Badge variant={main.enabled ? "default" : "secondary"}>{main.enabled ? "On" : "Off"}</Badge>
                <Switch
                  checked={main.enabled}
                  disabled={unreadable || busy}
                  onCheckedChange={(v) => {
                    setDialogError(null)
                    setPending(v)
                  }}
                  aria-label="Text-to-Buy main line on or off"
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">Number</dt>
              <dd className="font-mono break-all">{main.number || "Not set"}</dd>
              <dt className="text-muted-foreground">Phone last heard</dt>
              <dd className={main.lastHeardAt && !quiet ? "" : "font-medium text-red-600 dark:text-red-400"}>{relativeTime(main.lastHeardAt, now)}</dd>
            </dl>

            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">Today</div>
              <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {funnelSteps(main.today).map((s) => (
                  <li key={s.label} className="rounded-lg border p-2">
                    <div className="text-xs text-muted-foreground">{s.label}</div>
                    <div className="text-xl font-semibold tabular-nums">{s.count}</div>
                    <div className="text-[11px] text-muted-foreground">{s.pct === null ? " " : `${s.pct}% of previous`}</div>
                  </li>
                ))}
              </ol>
            </div>

            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">By service today</div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground">
                      <th className="py-1 pr-3 font-medium">Service</th>
                      <th className="py-1 pr-3 text-right font-medium">Prompts</th>
                      <th className="py-1 pr-3 text-right font-medium">Paid</th>
                      <th className="py-1 text-right font-medium">Delivered</th>
                    </tr>
                  </thead>
                  <tbody>
                    {serviceRows.map((s) => {
                      const c = data.services?.[s.key] ?? { prompts: 0, paid: 0, delivered: 0 }
                      return (
                        <tr key={s.key} className="border-t">
                          <td className="py-1.5 pr-3">
                            {s.label}
                            {!s.on && <Badge variant="secondary" className="ml-2">Off</Badge>}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{c.prompts}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{c.paid}</td>
                          <td className="py-1.5 text-right tabular-nums">{c.delivered}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <p>{readSplit(main.today.ruleReads, main.today.aiReads)}</p>
            <p>{smsCostText(main.today.replies, data.smsRateGhs)}</p>
          </CardContent>
        </Card>

        <Card className="opacity-60" aria-disabled="true">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-base">Shop line</CardTitle>
              <Switch checked={false} disabled aria-label="Shop line on or off (not available yet)" />
            </div>
          </CardHeader>
          <CardContent className="space-y-1 text-sm text-muted-foreground">
            <p>Coming in a later stage</p>
            <p>Reply sender ID: {data.settings.shopReplySenderId || "default"}</p>
          </CardContent>
        </Card>
      </div>

      <Dialog open={pending !== null} onOpenChange={(o) => !o && !busy && setPending(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{pending ? "Turn Text-to-Buy on?" : "Turn Text-to-Buy off?"}</DialogTitle>
            <DialogDescription>
              {pending
                ? "Customers texting the main number will start getting replies and MoMo prompts. Make sure the gateway row 'Text orders (SMS)' and SMS replies are set up."
                : "Texts to the main number go back to being handled exactly as before. Orders already prompted are not cancelled."}
            </DialogDescription>
          </DialogHeader>
          {dialogError && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{dialogError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)} disabled={busy}>Cancel</Button>
            <Button onClick={() => pending !== null && void apply(pending)} disabled={busy}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {pending ? "Turn on" : "Turn off"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
