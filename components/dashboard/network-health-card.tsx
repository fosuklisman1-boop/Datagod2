"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Activity, RefreshCw } from "lucide-react"
import type { NetworkHealthStat } from "@/lib/order-health-service"

interface NetworkHealthCardProps {
  networks: NetworkHealthStat[]
  loading: boolean
  onRefresh: () => void
}

const STATUS_LABEL: Record<NetworkHealthStat["status"], string> = {
  optimal: "Optimal",
  degraded: "Degraded",
  down: "Down",
  no_data: "No data yet",
}

const STATUS_BADGE_CLASS: Record<NetworkHealthStat["status"], string> = {
  optimal: "bg-success/15 text-success border-border",
  degraded: "bg-warning/15 text-warning border-border",
  down: "bg-destructive/15 text-destructive border-border",
  no_data: "bg-muted text-muted-foreground border-border",
}

const STATUS_BAR_CLASS: Record<NetworkHealthStat["status"], string> = {
  optimal: "bg-success",
  degraded: "bg-warning",
  down: "bg-destructive",
  no_data: "bg-muted",
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

function summarize(networks: NetworkHealthStat[]): string {
  const withData = networks.filter((n) => n.status !== "no_data")
  if (withData.length === 0) return "No recent data"
  const optimalCount = withData.filter((n) => n.status === "optimal").length
  return optimalCount === withData.length
    ? "All Networks Optimal"
    : `${optimalCount}/${withData.length} Networks Optimal`
}

export function NetworkHealthCard({ networks, loading, onRefresh }: NetworkHealthCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="w-4 h-4 text-primary" /> Network Health
            </CardTitle>
            <CardDescription>{networks.length > 0 ? summarize(networks) : "Last 24 hours"}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading && networks.length === 0 ? (
          <div className="p-4 text-center text-sm text-muted-foreground">Loading...</div>
        ) : (
          <div className="space-y-4">
            {networks.map((stat) => (
              <div key={stat.network} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{stat.network}</span>
                  <Badge variant="outline" className={STATUS_BADGE_CLASS[stat.status]}>
                    {STATUS_LABEL[stat.status]}
                  </Badge>
                </div>
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full ${STATUS_BAR_CLASS[stat.status]}`}
                    style={{ width: stat.uptimePercent !== null ? `${stat.uptimePercent}%` : "0%" }}
                  />
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {stat.avgDeliveryMinutes !== null ? `Avg delivery: ${formatMinutes(stat.avgDeliveryMinutes)}` : "No data yet"}
                  </span>
                  <span>{stat.uptimePercent !== null ? `Uptime: ${stat.uptimePercent}%` : "No data yet"}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
