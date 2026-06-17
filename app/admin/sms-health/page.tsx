"use client"

import { useEffect, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useAdminProtected } from "@/hooks/use-admin"
import { supabase } from "@/lib/supabase"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Loader2, RefreshCw, MessageSquare, CheckCircle2, XCircle, Clock, AlertCircle } from "lucide-react"

interface TypeRow { type: string; total: number; delivered: number; failed: number; sent: number }
interface ProviderRow { provider: string; total: number; delivered: number; failed: number }
interface FailureRow { phone_number: string; message_type: string; error_message: string; created_at: string }

const WINDOWS = [
  { label: "24h", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "7 days", hours: 168 },
]

function rate(delivered: number, failed: number): string {
  const resolved = delivered + failed
  if (resolved === 0) return "—"
  return `${Math.round((100 * delivered) / resolved)}%`
}

export default function SmsHealthPage() {
  useAdminProtected()
  const [hours, setHours] = useState(24)
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async (h: number) => {
    setLoading(true); setError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`/api/admin/sms-health?hours=${h}`, {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      })
      const d = await res.json()
      if (!res.ok) { setError(d.error || "Failed to load"); setData(null); return }
      setData(d)
    } catch { setError("Network error") } finally { setLoading(false) }
  }

  useEffect(() => { load(hours) }, [hours])

  const overall = data?.overall || {}
  const byType: TypeRow[] = data?.by_type || []
  const byProvider: ProviderRow[] = data?.by_provider || []
  const failures: FailureRow[] = data?.recent_failures || []
  const otp = byType.find((t) => t.type === "phone_otp")

  return (
    <DashboardLayout>
      <div className="p-6 max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black text-foreground flex items-center gap-2">
              <MessageSquare className="w-6 h-6 text-primary" /> SMS Health
            </h1>
            <p className="text-sm text-muted-foreground mt-1">Real delivery outcomes (delivered vs failed), not just gateway acceptance.</p>
          </div>
          <div className="flex items-center gap-2">
            {WINDOWS.map((w) => (
              <Button key={w.hours} size="sm" variant={hours === w.hours ? "default" : "outline"} onClick={() => setHours(w.hours)}>
                {w.label}
              </Button>
            ))}
            <Button size="sm" variant="outline" onClick={() => load(hours)} disabled={loading}>
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        {error && (
          <Card className="border-border bg-destructive/10">
            <CardContent className="pt-6 flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-destructive mt-0.5" />
              <div className="text-sm text-destructive">{error}</div>
            </CardContent>
          </Card>
        )}

        {loading && !data ? (
          <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
        ) : data ? (
          <>
            {/* OTP auto-failover breaker banner */}
            {data?.otp_breaker?.open && (
              <Card className="border-warning/30 bg-warning/10">
                <CardContent className="pt-5 pb-4 flex items-start gap-2 text-sm text-warning">
                  <AlertCircle className="w-5 h-5 text-warning mt-0.5 flex-shrink-0" />
                  <span><b>OTP auto-failover active</b> — Moolre OTP delivery is failing, so OTP codes are currently routed to the fallback provider. Auto-recovers when Moolre is healthy again.</span>
                </CardContent>
              </Card>
            )}

            {/* Overall cards */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <StatCard label="Total" value={overall.total ?? 0} icon={<MessageSquare className="w-4 h-4 text-muted-foreground" />} />
              <StatCard label="Delivered" value={overall.delivered ?? 0} icon={<CheckCircle2 className="w-4 h-4 text-success" />} tone="green" />
              <StatCard label="Failed" value={overall.failed ?? 0} icon={<XCircle className="w-4 h-4 text-destructive" />} tone="red" />
              <StatCard label="Awaiting DLR" value={overall.sent ?? 0} icon={<Clock className="w-4 h-4 text-warning" />} tone="amber" />
              <StatCard label="Delivery rate" value={rate(overall.delivered ?? 0, overall.failed ?? 0)} tone="violet" />
            </div>

            {/* OTP callout */}
            {otp && (
              <Card className="border-border bg-primary/50">
                <CardContent className="pt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                  <span className="font-bold text-primary">OTP codes ({otp.total})</span>
                  <span className="text-success">✓ {otp.delivered} delivered</span>
                  <span className="text-destructive">✗ {otp.failed} failed</span>
                  <span className="text-warning">◷ {otp.sent} awaiting</span>
                  <span className="ml-auto font-bold text-primary">Delivery: {rate(otp.delivered, otp.failed)}</span>
                </CardContent>
              </Card>
            )}

            {/* By type */}
            <Card>
              <CardHeader><CardTitle className="text-lg">By message type</CardTitle><CardDescription>Delivery breakdown per category</CardDescription></CardHeader>
              <CardContent>
                <Table rows={byType.map((t) => [t.type, t.total, t.delivered, t.failed, t.sent, rate(t.delivered, t.failed)])}
                  headers={["Type", "Total", "Delivered", "Failed", "Awaiting", "Rate"]} />
              </CardContent>
            </Card>

            {/* By provider */}
            <Card>
              <CardHeader><CardTitle className="text-lg">By provider</CardTitle><CardDescription>Which gateway delivered</CardDescription></CardHeader>
              <CardContent>
                <Table rows={byProvider.map((p) => [p.provider, p.total, p.delivered, p.failed, rate(p.delivered, p.failed)])}
                  headers={["Provider", "Total", "Delivered", "Failed", "Rate"]} />
              </CardContent>
            </Card>

            {/* Recent failures */}
            <Card>
              <CardHeader><CardTitle className="text-lg">Recent failures</CardTitle><CardDescription>Last 20 failed sends (numbers masked)</CardDescription></CardHeader>
              <CardContent>
                {failures.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No failures in this window 🎉</p>
                ) : (
                  <div className="space-y-2">
                    {failures.map((f, i) => (
                      <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm border-b border-border pb-2">
                        <span className="font-mono text-foreground">{f.phone_number}</span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">{f.message_type}</span>
                        <span className="text-destructive flex-1 min-w-0 truncate">{f.error_message}</span>
                        <span className="text-xs text-muted-foreground">{new Date(f.created_at).toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <p className="text-xs text-muted-foreground">
              "Awaiting DLR" = accepted by the gateway, delivery not yet confirmed (resolves within a few minutes via the sms-delivery-sync cron). Only Moolre supports delivery reports; other providers show as awaiting.
            </p>
          </>
        ) : null}
      </div>
    </DashboardLayout>
  )
}

function StatCard({ label, value, icon, tone }: { label: string; value: number | string; icon?: React.ReactNode; tone?: "green" | "red" | "amber" | "violet" }) {
  const toneClass = tone === "green" ? "text-success" : tone === "red" ? "text-destructive" : tone === "amber" ? "text-warning" : tone === "violet" ? "text-primary" : "text-foreground"
  return (
    <Card>
      <CardContent className="pt-5 pb-4">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">{icon}{label}</div>
        <div className={`text-2xl font-black ${toneClass}`}>{value}</div>
      </CardContent>
    </Card>
  )
}

function Table({ headers, rows }: { headers: string[]; rows: (string | number)[][] }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No data in this window.</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-foreground border-b border-border">
            {headers.map((h, i) => <th key={i} className={`py-2 ${i === 0 ? "" : "text-right"}`}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border">
              {r.map((c, j) => <td key={j} className={`py-2 ${j === 0 ? "font-medium text-foreground" : "text-right text-foreground"}`}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
