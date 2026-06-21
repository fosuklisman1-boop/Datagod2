"use client"

import { useCallback, useEffect, useState } from "react"
import { adminMessagingService } from "@/lib/admin-service"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "sonner"
import { Clock, Loader2, Mail, MessageCircle, MessageSquare, RefreshCw, Bell } from "lucide-react"

interface ChannelResult {
  sent?: number
  failed?: number
}
interface BroadcastLog {
  id: string
  subject: string | null
  message: string | null
  status: string
  channels: string[]
  target_type: string | null
  target_group: string[] | null
  created_at: string
  results: {
    total?: number
    sms?: ChannelResult
    email?: ChannelResult
    whatsapp?: ChannelResult
    push?: ChannelResult
  } | null
  admin?: { first_name?: string | null } | null
}

const CHANNEL_ICON: Record<string, typeof Mail> = {
  email: Mail,
  sms: MessageSquare,
  whatsapp: MessageCircle,
  push: Bell,
}

function audienceLabel(log: BroadcastLog): string {
  if (log.target_type === "group") {
    const g = log.target_group?.[0] ?? ""
    return g.startsWith("group:") ? "Address-book group" : "Group"
  }
  if (log.target_type === "specific") return "Specific users"
  if (log.target_type === "roles") return `Roles: ${(log.target_group ?? []).join(", ") || "—"}`
  return log.target_type ?? "—"
}

function totalSent(r: BroadcastLog["results"]): number {
  if (!r) return 0
  return (r.sms?.sent ?? 0) + (r.email?.sent ?? 0) + (r.whatsapp?.sent ?? 0) + (r.push?.sent ?? 0)
}
function totalFailed(r: BroadcastLog["results"]): number {
  if (!r) return 0
  return (r.sms?.failed ?? 0) + (r.email?.failed ?? 0) + (r.whatsapp?.failed ?? 0) + (r.push?.failed ?? 0)
}

export default function HistoryTab() {
  const [logs, setLogs] = useState<BroadcastLog[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const data = await adminMessagingService.getBroadcastLogs()
      setLogs((data as BroadcastLog[]) ?? [])
    } catch {
      toast.error("Failed to load broadcast history")
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Recent broadcasts sent from the SMS Centre and Broadcast composer.</p>
        <Button variant="outline" size="sm" onClick={() => load(true)} disabled={refreshing}>
          {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh
        </Button>
      </div>

      {logs.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">No broadcasts yet.</CardContent>
        </Card>
      ) : (
        logs.map((log) => {
          const sent = totalSent(log.results)
          const failed = totalFailed(log.results)
          const total = log.results?.total ?? 0
          return (
            <Card key={log.id}>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="flex items-center gap-2 text-base">
                      {log.subject || "Broadcast"}
                      <Badge variant="secondary">{log.status}</Badge>
                    </CardTitle>
                    <CardDescription className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {new Date(log.created_at).toLocaleString()}
                      </span>
                      <span>· {audienceLabel(log)}</span>
                      {log.admin?.first_name && <span>· by {log.admin.first_name}</span>}
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {(log.channels ?? []).map((ch) => {
                      const Icon = CHANNEL_ICON[ch]
                      return Icon ? (
                        <span key={ch} title={ch} className="text-muted-foreground">
                          <Icon className="h-4 w-4" />
                        </span>
                      ) : (
                        <Badge key={ch} variant="outline" className="text-[10px]">
                          {ch}
                        </Badge>
                      )
                    })}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {log.message && (
                  <p className="rounded-lg border bg-muted/40 p-2 text-sm italic text-muted-foreground line-clamp-2">
                    {log.message}
                  </p>
                )}
                <div className="grid grid-cols-3 gap-3 text-sm">
                  <div className="rounded-lg border p-2">
                    <p className="text-xs text-muted-foreground">Recipients</p>
                    <p className="text-lg font-bold">{total}</p>
                  </div>
                  <div className="rounded-lg border p-2">
                    <p className="text-xs text-muted-foreground">Sent</p>
                    <p className="text-lg font-bold text-success">{sent}</p>
                  </div>
                  <div className="rounded-lg border p-2">
                    <p className="text-xs text-muted-foreground">Failed</p>
                    <p className={`text-lg font-bold ${failed > 0 ? "text-destructive" : ""}`}>{failed}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })
      )}
    </div>
  )
}
