"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CheckCircle2, Clock, Moon, RefreshCw, Info } from "lucide-react"
import type { LatestOrderSummary } from "@/lib/order-health-service"

interface LatestOrderCardProps {
  order: LatestOrderSummary | null
  loading: boolean
  onRefresh: () => void
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

export function LatestOrderCard({ order, loading, onRefresh }: LatestOrderCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <CheckCircle2 className="w-4 h-4 text-success" />
            {order ? `Latest ${order.network} Successful Order` : "Latest Successful Order"}
          </CardTitle>
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Refresh" onClick={onRefresh} disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="p-4 text-center text-sm text-muted-foreground">Loading...</div>
        ) : !order ? (
          <div className="p-4 text-center text-sm text-muted-foreground">No completed orders yet</div>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              {order.durationMinutes !== null && (
                <Badge variant="secondary" title="Time from when this order was sent to the network provider to when it completed — not from when you placed it.">
                  Delivered in {formatDuration(order.durationMinutes)}
                </Badge>
              )}
              {order.avgNetworkDurationMinutes !== null && (
                <Badge variant="outline" title={`Average delivery time across other recent ${order.network} orders on the platform in the last 24h — not specific to this order.`}>
                  {order.network} network avg: ~{formatDuration(order.avgNetworkDurationMinutes)}
                </Badge>
              )}
              {order.isNight && (
                <Badge variant="outline" className="flex items-center gap-1">
                  <Moon className="w-3 h-3" /> Night
                </Badge>
              )}
            </div>
            {order.durationMinutes !== null && (
              <p className="text-[11px] text-muted-foreground">
                Delivery time is measured from provider dispatch, not from when you placed the order — the gap below reflects our own processing time.
              </p>
            )}

            <div className="flex items-center gap-2 text-xs text-muted-foreground pt-1">
              <Clock className="w-3.5 h-3.5" />
              <span>Placed: {formatTimestamp(order.createdAt)}</span>
              {order.completedAt && (
                <>
                  <span>•</span>
                  <span className="flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5 text-success" /> Completed: {formatTimestamp(order.completedAt)}
                  </span>
                </>
              )}
            </div>

            {order.hasHeldOrder && (
              <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-warning-foreground">
                <Info className="w-4 h-4 mt-0.5 shrink-0 text-warning" />
                <span>
                  One of your orders is currently pending an MTN number-validation check. This can add extra time before it completes.
                </span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
