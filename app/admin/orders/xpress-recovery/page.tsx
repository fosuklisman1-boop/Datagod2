"use client"

import { useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useAdminProtected } from "@/hooks/use-admin"
import { toast } from "sonner"
import { AlertTriangle, CheckCircle2, XCircle, RefreshCw, Loader2, ShieldAlert, CheckCheck } from "lucide-react"
import { supabase } from "@/lib/supabase"

interface RecoveryResult {
  mtn_order_id: string
  action: "restored" | "genuine_failure" | "skip" | "error"
  message: string
}

interface RecoverySummary {
  total: number
  restored: number
  genuine: number
  errors: number
  results: RecoveryResult[]
}

const ACTION_STYLES: Record<RecoveryResult["action"], {
  label: string
  variant: "default" | "secondary" | "destructive" | "outline"
  icon: React.ReactNode
}> = {
  restored:        { label: "Restored",         variant: "default",     icon: <CheckCheck className="h-3 w-3" /> },
  genuine_failure: { label: "Genuine failure",  variant: "secondary",   icon: <XCircle className="h-3 w-3" /> },
  skip:            { label: "Skipped",           variant: "outline",     icon: <AlertTriangle className="h-3 w-3" /> },
  error:           { label: "Error",             variant: "destructive", icon: <XCircle className="h-3 w-3" /> },
}

export default function XpressRecoveryPage() {
  const { loading: authLoading } = useAdminProtected()
  const [running, setRunning] = useState(false)
  const [summary, setSummary] = useState<RecoverySummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function runRecovery() {
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
        setError(json.error || "Recovery failed")
        toast.error("Recovery failed")
        return
      }

      setSummary(json)

      if (json.restored > 0) {
        toast.success(`Restored ${json.restored} order${json.restored !== 1 ? "s" : ""} to completed`)
      } else {
        toast.success("Recovery complete — no wrongly-failed orders found")
      }
    } catch (err: any) {
      setError(err.message || "Network error")
      toast.error("Recovery failed")
    } finally {
      setRunning(false)
    }
  }

  if (authLoading) return null

  return (
    <DashboardLayout>
      <div className="max-w-3xl mx-auto space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldAlert className="h-6 w-6 text-orange-500" />
            Xpress Reversal Recovery
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Finds all Xpress orders currently marked <strong>failed</strong> in our system and
            checks the actual status with Xpress directly. Orders Xpress confirms as
            <strong> completed</strong> (data was delivered) are restored to <strong>completed</strong> —
            no re-fulfillment needed. Orders Xpress still reports as failed remain in
            <strong> pending</strong> for manual re-fulfillment.
          </p>
        </div>

        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Safe to run multiple times — already-restored orders are back in <code>completed</code> and
            won&apos;t appear in this scan again. The run may take a minute if many orders are checked.
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Run Recovery Scan</CardTitle>
            <CardDescription>
              Queries Xpress for every failed tracking row and restores the ones Xpress confirms
              were actually delivered.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={runRecovery} disabled={running} className="gap-2">
              {running ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Scanning Xpress orders…</>
              ) : (
                <><RefreshCw className="h-4 w-4" /> Run Recovery</>
              )}
            </Button>
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
            <div className="grid grid-cols-4 gap-3">
              <Card className="text-center p-4">
                <div className="text-2xl font-bold">{summary.total}</div>
                <div className="text-xs text-muted-foreground mt-1">Checked</div>
              </Card>
              <Card className="text-center p-4 border-emerald-500/30 bg-emerald-500/5">
                <div className="text-2xl font-bold text-emerald-600">{summary.restored}</div>
                <div className="text-xs text-muted-foreground mt-1">Restored</div>
              </Card>
              <Card className="text-center p-4">
                <div className="text-2xl font-bold text-muted-foreground">{summary.genuine}</div>
                <div className="text-xs text-muted-foreground mt-1">Genuine failures</div>
              </Card>
              <Card className="text-center p-4 border-destructive/30 bg-destructive/5">
                <div className="text-2xl font-bold text-destructive">{summary.errors}</div>
                <div className="text-xs text-muted-foreground mt-1">Errors</div>
              </Card>
            </div>

            {summary.restored === 0 && summary.errors === 0 && (
              <Alert>
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                <AlertDescription>
                  No wrongly-failed orders found. All {summary.genuine} failed Xpress orders are
                  genuine failures — they remain in pending for manual re-fulfillment.
                </AlertDescription>
              </Alert>
            )}

            {summary.restored > 0 && (
              <Alert>
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                <AlertDescription>
                  {summary.restored} order{summary.restored !== 1 ? "s" : ""} restored to{" "}
                  <strong>completed</strong> — data was already delivered to these customers.
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
                      const style = ACTION_STYLES[r.action] ?? ACTION_STYLES.error
                      return (
                        <div key={i} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                          <code className="font-mono text-xs text-muted-foreground flex-none w-28 truncate">
                            {r.mtn_order_id}
                          </code>
                          <Badge variant={style.variant} className="gap-1 flex-none">
                            {style.icon}
                            {style.label}
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
