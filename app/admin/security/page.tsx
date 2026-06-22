"use client"

import { useCallback, useEffect, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useAdminProtected } from "@/hooks/use-admin"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { ShieldAlert, Loader2, CheckCircle2, RefreshCw } from "lucide-react"

interface SecurityAlert {
  id: string
  created_at: string
  severity: "critical" | "high" | "info"
  category: string
  title: string
  detail: any
  source: string
  actor: string | null
  ip: string | null
  acknowledged_at: string | null
  notified_at: string | null
  channels_sent: string[] | null
}

const SEV_STYLE: Record<string, string> = {
  critical: "bg-red-500/15 text-red-600 border-red-500/30",
  high: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  info: "bg-muted text-muted-foreground border-border",
}

type Filter = "unacked" | "critical" | "all"

export default function AdminSecurityPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [alerts, setAlerts] = useState<SecurityAlert[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>("unacked")
  const [acking, setAcking] = useState<string | null>(null)

  const authHeaders = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return {
      Authorization: `Bearer ${session?.access_token || ""}`,
      "Content-Type": "application/json",
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const headers = await authHeaders()
      const qs = filter === "critical" ? "?severity=critical" : ""
      const res = await fetch(`/api/admin/security-alerts${qs}`, { headers })
      if (!res.ok) throw new Error("load failed")
      const data = await res.json()
      setAlerts(data.alerts || [])
    } catch {
      toast.error("Failed to load security alerts")
    } finally {
      setLoading(false)
    }
  }, [filter, authHeaders])

  useEffect(() => {
    if (isAdmin) load()
  }, [isAdmin, load])

  // Live feed — new alerts arrive via Supabase Realtime (RLS admin-read gates rows).
  useEffect(() => {
    if (!isAdmin) return
    const channel = supabase
      .channel("security_alerts_feed")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "security_alerts" },
        (payload) => {
          const a = payload.new as SecurityAlert
          setAlerts((prev) => (prev.some((x) => x.id === a.id) ? prev : [a, ...prev].slice(0, 300)))
          if (a.severity === "critical") toast.error(`🚨 ${a.title}`)
          else if (a.severity === "high") toast(`⚠️ ${a.title}`)
        }
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [isAdmin])

  const acknowledge = async (id: string) => {
    setAcking(id)
    try {
      const headers = await authHeaders()
      const res = await fetch("/api/admin/security-alerts", {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "acknowledge", id }),
      })
      if (!res.ok) throw new Error()
      setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, acknowledged_at: new Date().toISOString() } : a)))
    } catch {
      toast.error("Failed to acknowledge")
    } finally {
      setAcking(null)
    }
  }

  if (adminLoading) {
    return (
      <DashboardLayout>
        <div className="flex justify-center p-12"><Loader2 className="w-6 h-6 animate-spin" /></div>
      </DashboardLayout>
    )
  }
  if (!isAdmin) return null

  const shown = filter === "unacked" ? alerts.filter((a) => !a.acknowledged_at) : alerts
  const criticalUnacked = alerts.filter((a) => a.severity === "critical" && !a.acknowledged_at).length

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <ShieldAlert className="w-6 h-6 text-destructive" /> Security Alerts
            </h1>
            <p className="text-sm text-muted-foreground">
              Real-time database-level attack detection.{" "}
              {criticalUnacked > 0 && <span className="text-red-600 font-medium">{criticalUnacked} critical unacknowledged</span>}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>

        <div className="flex gap-2">
          {(["unacked", "critical", "all"] as Filter[]).map((f) => (
            <Button key={f} variant={filter === f ? "default" : "outline"} size="sm" onClick={() => setFilter(f)}>
              {f === "unacked" ? "Unacknowledged" : f === "critical" ? "Critical" : "All"}
            </Button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center p-12"><Loader2 className="w-6 h-6 animate-spin" /></div>
        ) : shown.length === 0 ? (
          <Card>
            <CardContent className="p-8 text-center text-muted-foreground">
              <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-green-500" />
              No {filter === "unacked" ? "unacknowledged " : ""}alerts. All clear.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {shown.map((a) => (
              <Card key={a.id} className={a.acknowledged_at ? "opacity-60" : ""}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className={SEV_STYLE[a.severity]}>{a.severity.toUpperCase()}</Badge>
                        <span className="text-xs text-muted-foreground font-normal">{a.category}</span>
                      </CardTitle>
                      <p className="mt-1 font-medium">{a.title}</p>
                    </div>
                    {!a.acknowledged_at ? (
                      <Button size="sm" variant="outline" onClick={() => acknowledge(a.id)} disabled={acking === a.id}>
                        {acking === a.id ? <Loader2 className="w-4 h-4 animate-spin" /> : "Acknowledge"}
                      </Button>
                    ) : (
                      <Badge variant="secondary" className="shrink-0"><CheckCircle2 className="w-3 h-3 mr-1" /> Acked</Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                    <span>{new Date(a.created_at).toLocaleString()}</span>
                    {a.actor && <span>actor: {a.actor}</span>}
                    {a.ip && <span>ip: {a.ip}</span>}
                    <span>via: {(a.channels_sent || []).join(", ") || (a.notified_at ? "—" : "pending")}</span>
                  </div>
                  {a.detail && Object.keys(a.detail).length > 0 && (
                    <pre className="mt-2 text-xs bg-muted/50 rounded p-2 overflow-auto max-h-40">{JSON.stringify(a.detail, null, 2)}</pre>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
