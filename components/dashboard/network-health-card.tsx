"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Activity, RefreshCw } from "lucide-react"
import type { NetworkHealthStat, HealthNetwork } from "@/lib/order-health-service"
import { GatewayHealthCard } from "@/components/shared/gateway-health-card"
import type { GatewayNetwork } from "@/lib/network-status-theme"

interface NetworkHealthCardProps {
  networks: NetworkHealthStat[]
  loading: boolean
  onRefresh: () => void
}

// Maps this app's real network names to GatewayHealthCard's badge shape.
// Exported so other dashboard sections (e.g. the network quick-shortcuts row)
// reuse the exact same badge styling instead of redefining it.
export const NETWORK_BADGE: Record<HealthNetwork, { network: GatewayNetwork; badgeText: string }> = {
  MTN: { network: "mtn", badgeText: "MTN" },
  Telecel: { network: "telecel", badgeText: "TEL" },
  "AT - iShare": { network: "at", badgeText: "iS" },
  "AT - BigTime": { network: "bigtime", badgeText: "BT" },
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
          <div className="grid gap-3 sm:grid-cols-2">
            {networks.map((stat) => {
              const badge = NETWORK_BADGE[stat.network]
              if (stat.status === "no_data" || stat.uptimePercent === null) {
                // No fabricated 0% -- 0% would claim "completely down", which
                // is a different, false claim from "we have no data yet".
                return (
                  <div key={stat.network} className="flex-1 rounded-xl border border-border p-3.5">
                    <div className="flex items-center gap-2">
                      <div className="flex h-6 w-6 items-center justify-center rounded-md bg-muted text-[8px] font-extrabold text-muted-foreground">
                        {badge.badgeText}
                      </div>
                      <span className="text-sm font-semibold text-foreground">{stat.network}</span>
                    </div>
                    <p className="mt-3 text-[11px] text-muted-foreground">No recent data</p>
                  </div>
                )
              }
              return (
                <GatewayHealthCard
                  key={stat.network}
                  label={stat.network}
                  badgeText={badge.badgeText}
                  network={badge.network}
                  metricLabel={stat.avgDeliveryMinutes !== null ? `Avg ${formatMinutes(stat.avgDeliveryMinutes)}` : "No data"}
                  uptimePct={stat.uptimePercent}
                />
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
