"use client"

import Link from "next/link"
import { AlertCircle } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  HEALTH_LABELS,
  formatDeliveryRate,
  formatRelativeTime,
  sortSenderHealth,
  type SenderHealthRowWithStatus,
  type SenderHealthStatus,
} from "@/lib/sms/sender-health"

const HEALTH_TONE: Record<SenderHealthStatus, string> = {
  not_delivering: "bg-destructive/15 text-destructive border-destructive/30",
  degraded: "bg-warning/15 text-warning border-warning/30",
  healthy: "bg-success/15 text-success border-success/30",
  insufficient: "bg-muted text-muted-foreground border-border",
}

function registryBadge(r: SenderHealthRowWithStatus): { label: string; tone: string } {
  if (r.is_pool) return { label: "pool", tone: "bg-primary/10 text-primary border-primary/30" }
  switch (r.registry_status) {
    case "active": return { label: "active", tone: "bg-success/15 text-success border-success/30" }
    case "paused": return { label: "paused", tone: "bg-warning/15 text-warning border-warning/30" }
    case "revoked":
    case "rejected": return { label: r.registry_status, tone: "bg-destructive/15 text-destructive border-destructive/30" }
    case "pending": return { label: "pending", tone: "bg-muted text-muted-foreground border-border" }
    case null: return { label: "none", tone: "bg-muted text-muted-foreground border-border" }
    default: return { label: r.registry_status, tone: "bg-muted text-muted-foreground border-border" }
  }
}

function Pill({ label, tone }: { label: string; tone: string }) {
  return <span className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold ${tone}`}>{label}</span>
}

export function SenderHealthCard({ rows, error }: { rows: SenderHealthRowWithStatus[] | null | undefined; error?: string }) {
  const sorted = rows ? sortSenderHealth(rows) : null
  const now = new Date()

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Sender ID health</CardTitle>
        <CardDescription>Delivery outcomes per sender name in this window</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Hubtel only — Moolre does not report delivery. A name that Hubtel accepts can still be dropped by a carrier:{" "}
          <b>Not delivering</b> = 10+ sends and none delivered. Ask Hubtel to register the name with the carriers, or pause it in{" "}
          <Link href="/admin/sms?tab=sender-ids" className="text-primary underline underline-offset-2">Admin → SMS → Sender IDs</Link>.
        </p>

        {error ? (
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        ) : !sorted || sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">No Hubtel sends in this window.</p>
        ) : (
          <>
            {/* Phones: stacked cards */}
            <div className="space-y-3 md:hidden">
              {sorted.map((r) => {
                const reg = registryBadge(r)
                return (
                  <div key={r.sender} className="rounded-lg border border-border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-semibold text-foreground break-all">{r.sender}</span>
                      <Pill {...reg} />
                      <span className="ml-auto"><Pill label={HEALTH_LABELS[r.status]} tone={HEALTH_TONE[r.status]} /></span>
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1 text-xs">
                      <span className="text-muted-foreground">Sent <b className="text-foreground">{r.total}</b></span>
                      <span className="text-muted-foreground">Delivered <b className="text-success">{r.delivered}</b></span>
                      <span className="text-muted-foreground">Failed <b className="text-destructive">{r.failed}</b></span>
                      <span className="text-muted-foreground">In flight <b className="text-warning">{r.in_flight}</b></span>
                      <span className="text-muted-foreground">Rate <b className="text-foreground">{formatDeliveryRate(r.delivery_rate)}</b></span>
                      <span className="text-muted-foreground">Last ✓ <b className="text-foreground">{formatRelativeTime(r.last_delivered_at, now)}</b></span>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* md+: table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-2">Sender</th>
                    <th className="py-2">Registry</th>
                    <th className="py-2 text-right">Sent</th>
                    <th className="py-2 text-right">Delivered</th>
                    <th className="py-2 text-right">Failed</th>
                    <th className="py-2 text-right">In flight</th>
                    <th className="py-2 text-right">Rate</th>
                    <th className="py-2 text-right">Last delivered</th>
                    <th className="py-2 pl-3">Health</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => {
                    const reg = registryBadge(r)
                    return (
                      <tr key={r.sender} className="border-b border-border">
                        <td className="py-2 font-mono font-medium text-foreground">{r.sender}</td>
                        <td className="py-2"><Pill {...reg} /></td>
                        <td className="py-2 text-right text-foreground">{r.total}</td>
                        <td className="py-2 text-right text-success">{r.delivered}</td>
                        <td className="py-2 text-right text-destructive">{r.failed}</td>
                        <td className="py-2 text-right text-warning">{r.in_flight}</td>
                        <td className="py-2 text-right font-semibold text-foreground">{formatDeliveryRate(r.delivery_rate)}</td>
                        <td className="py-2 text-right text-muted-foreground" title={r.last_delivered_at ?? undefined}>
                          {formatRelativeTime(r.last_delivered_at, now)}
                        </td>
                        <td className="py-2 pl-3"><Pill label={HEALTH_LABELS[r.status]} tone={HEALTH_TONE[r.status]} /></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
