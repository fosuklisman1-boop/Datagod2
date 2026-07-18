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
  ShieldAlert, CheckCheck, RotateCcw, Clock, Minus,
} from "lucide-react"
import { supabase } from "@/lib/supabase"

type Action = "completed" | "requeued" | "restored" | "genuine_failure" | "no_change" | "skip" | "error"

interface RecoveryResult {
  mtn_order_id: string
  was: string
  action: Action
  message: string
}

interface RecoverySummary {
  total: number
  completed: number
  requeued: number
  restored: number
  genuine: number
  noChange: number
  errors: number
  results: RecoveryResult[]
}

const ACTION_META: Record<Action, {
  label: string
  variant: "default" | "secondary" | "destructive" | "outline"
  icon: React.ReactNode
}> = {
  completed:       { label: "Completed",        variant: "default",     icon: <CheckCheck className="h-3 w-3" /> },
  requeued:        { label: "Re-queued",         variant: "secondary",   icon: <RotateCcw className="h-3 w-3" /> },
  restored:        { label: "Restored",          variant: "default",     icon: <CheckCircle2 className="h-3 w-3" /> },
  genuine_failure: { label: "Genuine failure",   variant: "outline",     icon: <XCircle className="h-3 w-3" /> },
  no_change:       { label: "Still in flight",   variant: "outline",     icon: <Clock className="h-3 w-3" /> },
  skip:            { label: "Skipped",           variant: "outline",     icon: <Minus className="h-3 w-3" /> },
  error:           { label: "Error",             variant: "destructive", icon: <XCircle className="h-3 w-3" /> },
}

export default function XpressRecoveryPage() {
  const { loading: authLoading } = useAdminProtected()
  const [running, setRunning] = useState(false)
  const [cronRunning, setCronRunning] = useState(false)
  const [summary, setSummary] = useState<RecoverySummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function runSync() {
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
      })

      const json = await res.json()

      if (!res.ok) {
        setError(json.error || "Sync failed")
        toast.error("Sync failed")
        return
      }

      setSummary(json)

      const fixed = (json.completed ?? 0) + (json.requeued ?? 0) + (json.restored ?? 0)
      if (fixed > 0) {
        toast.success(`Fixed ${fixed} order${fixed !== 1 ? "s" : ""}`)
      } else {
        toast.success("Sync complete — nothing to fix")
      }
    } catch (err: any) {
      setError(err.message || "Network error")
      toast.error("Sync failed")
    } finally {
      setRunning(false)
    }
  }

  async function triggerCron() {
    setCronRunning(true)
    try {
      const res = await fetch("/api/cron/sync-mtn-status/xpress", {
        headers: { "x-cron-secret": process.env.NEXT_PUBLIC_CRON_SECRET || "" },
      })
      const json = await res.json()
      if (res.ok) {
        toast.success(`Cron ran: ${json.synced ?? 0} synced, ${json.reversed ?? 0} reversed`)
      } else {
        toast.error("Cron failed — check server logs")
      }
    } catch {
      toast.error("Could not reach cron endpoint")
    } finally {
      setCronRunning(false)
    }
  }

  if (authLoading) return null

  const fixed = summary ? (summary.completed + summary.requeued + summary.restored) : 0

  return (
    <DashboardLayout>
      <div className="max-w-3xl mx-auto space-y-6 p-6">

        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldAlert className="h-6 w-6 text-orange-500" />
            Xpress Order Sync
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Checks every Xpress order stuck in <strong>processing</strong> or <strong>failed</strong> against
            the Xpress API and applies the correct status. Covers both stuck orders and
            wrongly-reported failures.
          </p>
        </div>

        {/* What each outcome means */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">What this fixes</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-1.5">
            <div className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1.5">
              <span className="font-medium text-foreground">processing + ✓</span>
              <span>Xpress confirms delivery → marked <strong>completed</strong></span>
              <span className="font-medium text-foreground">processing + ✗</span>
              <span>Xpress confirms failure → tracking=failed, order back to <strong>pending</strong> for re-fulfillment</span>
              <span className="font-medium text-foreground">failed + ✓</span>
              <span>Xpress false-alarm webhook → restored to <strong>completed</strong> (data was delivered)</span>
              <span className="font-medium text-foreground">failed + ✗</span>
              <span>Genuine failure → no change, stays in <strong>pending</strong> for manual re-fulfillment</span>
            </div>
          </CardContent>
        </Card>

        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Safe to run multiple times. Already-corrected orders won&apos;t be in this scan.
            May take a minute for large queues.
          </AlertDescription>
        </Alert>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Full Sync (up to 300)</CardTitle>
              <CardDescription>
                Checks all processing + failed Xpress orders against Xpress API and corrects each one.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={runSync} disabled={running || cronRunning} className="gap-2">
                {running
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> Querying Xpress…</>
                  : <><RefreshCw className="h-4 w-4" /> Run Full Sync</>
                }
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Trigger Cron (next 50)</CardTitle>
              <CardDescription>
                Manually fires the scheduled poller — same as waiting for the next cron tick.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={triggerCron} disabled={running || cronRunning} className="gap-2">
                {cronRunning
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> Running cron…</>
                  : <><RefreshCw className="h-4 w-4" /> Trigger Cron</>
                }
              </Button>
            </CardContent>
          </Card>
        </div>

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
                { label: "Checked",  value: summary.total,    cls: "" },
                { label: "Completed", value: summary.completed, cls: "border-emerald-500/30 bg-emerald-500/5 text-emerald-600" },
                { label: "Re-queued", value: summary.requeued,  cls: "border-blue-500/30 bg-blue-500/5 text-blue-600" },
                { label: "Restored",  value: summary.restored,  cls: "border-emerald-500/30 bg-emerald-500/5 text-emerald-600" },
                { label: "Genuine ✗", value: summary.genuine,   cls: "" },
                { label: "Errors",    value: summary.errors,    cls: summary.errors > 0 ? "border-destructive/30 bg-destructive/5 text-destructive" : "" },
              ].map(({ label, value, cls }) => (
                <Card key={label} className={`text-center p-3 ${cls}`}>
                  <div className="text-xl font-bold">{value}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
                </Card>
              ))}
            </div>

            {fixed === 0 && summary.errors === 0 && (
              <Alert>
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                <AlertDescription>
                  Nothing to fix. {summary.genuine} genuine failure{summary.genuine !== 1 ? "s" : ""} stay in pending;
                  {" "}{summary.noChange} still in flight on Xpress.
                </AlertDescription>
              </Alert>
            )}

            {fixed > 0 && (
              <Alert>
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                <AlertDescription>
                  Fixed {fixed} order{fixed !== 1 ? "s" : ""}: {summary.completed} marked completed,{" "}
                  {summary.requeued} re-queued for fulfillment, {summary.restored} restored from false failure.
                </AlertDescription>
              </Alert>
            )}

            {summary.results.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Per-order log</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="divide-y max-h-96 overflow-y-auto">
                    {summary.results.map((r, i) => {
                      const meta = ACTION_META[r.action] ?? ACTION_META.error
                      return (
                        <div key={i} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                          <code className="font-mono text-xs text-muted-foreground flex-none w-28 truncate">
                            {r.mtn_order_id}
                          </code>
                          <Badge variant="outline" className="flex-none text-xs">
                            was: {r.was}
                          </Badge>
                          <Badge variant={meta.variant} className="gap-1 flex-none">
                            {meta.icon}
                            {meta.label}
                          </Badge>
                          <span className="text-muted-foreground truncate">{r.message}</span>
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
