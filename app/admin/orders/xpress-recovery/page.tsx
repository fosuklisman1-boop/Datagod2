"use client"

import { useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useAdminProtected } from "@/hooks/use-admin"
import { toast } from "sonner"
import {
  AlertTriangle, CheckCircle2, XCircle, RefreshCw, Loader2,
  ShieldAlert, CheckCheck, RotateCcw, Minus,
} from "lucide-react"
import { supabase } from "@/lib/supabase"

type Action = "reversed" | "completed" | "requeued" | "restored" | "skipped"

interface RecoveryResult {
  mtn_order_id: string
  was: string
  action: Action
  message: string
}

interface RecoverySummary {
  hours: number
  total: number
  fixed: number
  reversed: number
  completed: number
  requeued: number
  restored: number
  skipped: number
  results: RecoveryResult[]
}

const ACTION_META: Record<Action, {
  label: string
  variant: "default" | "secondary" | "destructive" | "outline"
  icon: React.ReactNode
}> = {
  reversed:  { label: "Reversed",    variant: "destructive", icon: <RotateCcw className="h-3 w-3" /> },
  completed: { label: "Completed",   variant: "default",     icon: <CheckCheck className="h-3 w-3" /> },
  requeued:  { label: "Re-queued",   variant: "secondary",   icon: <RefreshCw className="h-3 w-3" /> },
  restored:  { label: "Restored",    variant: "default",     icon: <CheckCircle2 className="h-3 w-3" /> },
  skipped:   { label: "No change",   variant: "outline",     icon: <Minus className="h-3 w-3" /> },
}

const HOUR_OPTIONS = [
  { label: "Past 24 h",  value: 24  },
  { label: "Past 72 h",  value: 72  },
  { label: "Past 7 days", value: 168 },
  { label: "Past 30 days", value: 720 },
]

export default function XpressRecoveryPage() {
  const { loading: authLoading } = useAdminProtected()
  const [running, setRunning] = useState(false)
  const [cronRunning, setCronRunning] = useState(false)
  const [hours, setHours] = useState(72)
  const [summary, setSummary] = useState<RecoverySummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function runReconcile() {
    setRunning(true)
    setError(null)
    setSummary(null)

    try {
      const { data: { session: sess } } = await supabase.auth.getSession()
      const token = sess?.access_token

      const res = await fetch("/api/admin/orders/recover-xpress-reversals", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ hours }),
      })

      const json = await res.json()

      if (!res.ok) {
        setError(json.error || "Reconciliation failed")
        toast.error("Reconciliation failed")
        return
      }

      setSummary(json)
      if ((json.fixed ?? 0) > 0) {
        toast.success(`Fixed ${json.fixed} order${json.fixed !== 1 ? "s" : ""}`)
      } else {
        toast.success(`Scan complete — ${json.total} orders checked, nothing to fix`)
      }
    } catch (err: any) {
      setError(err.message || "Network error")
      toast.error("Reconciliation failed")
    } finally {
      setRunning(false)
    }
  }

  async function triggerCron() {
    setCronRunning(true)
    try {
      const { data: { session: sess } } = await supabase.auth.getSession()
      const token = sess?.access_token

      const res = await fetch("/api/admin/orders/trigger-xpress-cron", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      })
      const json = await res.json()
      if (res.ok) {
        toast.success(`Cron ran: ${json.synced ?? 0} synced, ${json.reversed ?? 0} reversed`)
      } else {
        toast.error(json.error || "Cron failed — check server logs")
      }
    } catch {
      toast.error("Could not reach cron endpoint")
    } finally {
      setCronRunning(false)
    }
  }

  if (authLoading) return null

  return (
    <DashboardLayout>
      <div className="max-w-3xl mx-auto space-y-6 p-6">

        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldAlert className="h-6 w-6 text-orange-500" />
            Xpress Order Reconciliation
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Fetches <strong>all</strong> Xpress orders from a chosen time window, checks each against
            the live Xpress API, and corrects any status mismatches — regardless of what status they
            currently sit at in our system.
          </p>
        </div>

        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Safe to run multiple times. Orders that can&apos;t be found on Xpress (already
            re-fulfilled elsewhere) are silently skipped.
          </AlertDescription>
        </Alert>

        {/* Time window + action */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Run Reconciliation</CardTitle>
            <CardDescription>Choose how far back to scan, then run.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {HOUR_OPTIONS.map(opt => (
                <Button
                  key={opt.value}
                  variant={hours === opt.value ? "default" : "outline"}
                  size="sm"
                  onClick={() => setHours(opt.value)}
                  disabled={running}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
            <div className="flex gap-2">
              <Button onClick={runReconcile} disabled={running || cronRunning} className="gap-2">
                {running
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> Scanning…</>
                  : <><RefreshCw className="h-4 w-4" /> Run ({hours}h window)</>
                }
              </Button>
              <Button variant="outline" onClick={triggerCron} disabled={running || cronRunning} className="gap-2">
                {cronRunning
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> Running cron…</>
                  : <><RefreshCw className="h-4 w-4" /> Trigger Cron (50)</>
                }
              </Button>
            </div>
          </CardContent>
        </Card>

        {error && (
          <Alert variant="destructive">
            <XCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {summary && (
          <div className="space-y-4">
            {/* Summary tiles */}
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
              {[
                { label: "Checked",    value: summary.total,     cls: "" },
                { label: "Fixed",      value: summary.fixed,     cls: summary.fixed > 0 ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-600" : "" },
                { label: "Reversed",   value: summary.reversed,  cls: summary.reversed > 0 ? "border-orange-500/30 bg-orange-500/5 text-orange-600" : "" },
                { label: "Completed",  value: summary.completed, cls: "border-emerald-500/30 bg-emerald-500/5 text-emerald-600" },
                { label: "Re-queued",  value: summary.requeued,  cls: "" },
                { label: "Restored",   value: summary.restored,  cls: "border-emerald-500/30 bg-emerald-500/5 text-emerald-600" },
              ].map(({ label, value, cls }) => (
                <Card key={label} className={`text-center p-3 ${cls}`}>
                  <div className="text-xl font-bold">{value}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
                </Card>
              ))}
            </div>

            {summary.fixed === 0 && (
              <Alert>
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                <AlertDescription>
                  All {summary.total} Xpress orders in the past {summary.hours}h are in the correct state.
                </AlertDescription>
              </Alert>
            )}

            {summary.results.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Per-order log ({summary.results.length})</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="divide-y max-h-96 overflow-y-auto">
                    {summary.results
                      .filter(r => r.action !== "skipped")
                      .concat(summary.results.filter(r => r.action === "skipped"))
                      .map((r, i) => {
                        const meta = ACTION_META[r.action] ?? ACTION_META.skipped
                        return (
                          <div key={i} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                            <code className="font-mono text-xs text-muted-foreground flex-none w-28 truncate">
                              {r.mtn_order_id}
                            </code>
                            <Badge variant="outline" className="flex-none text-xs">
                              {r.was}
                            </Badge>
                            <Badge variant={meta.variant} className="gap-1 flex-none">
                              {meta.icon}
                              {meta.label}
                            </Badge>
                            <span className="text-muted-foreground truncate text-xs">{r.message}</span>
                          </div>
                        )
                      })}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
