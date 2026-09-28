"use client"

import { Activity, Zap } from "lucide-react"
import type { NetworkHealthStat, HealthNetwork } from "@/lib/order-health-service"

interface NetworkHealthCardProps {
  networks: NetworkHealthStat[]
  loading: boolean
  onRefresh: () => void
}

// Circle badge: real brand tokens (bg-mtn/telecel/at already calibrated to
// real network brand colors, unlike the generic primary/success palette).
// bigtime has no brand token (single-usage accent), so it stays a literal
// violet matching the rest of this app's bigtime convention.
export const NETWORK_BADGE: Record<HealthNetwork, { text: string; className: string }> = {
  MTN: { text: "MTN", className: "bg-mtn text-mtn-foreground" },
  Telecel: { text: "TEL", className: "bg-telecel text-telecel-foreground" },
  "AT - iShare": { text: "iS", className: "bg-at text-at-foreground" },
  "AT - BigTime": { text: "BT", className: "bg-violet-600 text-white" },
}

// Bar colors sampled from the reference (a clean green for "optimal") rather
// than this app's --success token, per explicit direction to match the
// reference's own palette on this page. Degraded/down aren't shown in the
// reference screenshots, so those fall back to standard amber/red.
function barColor(status: NetworkHealthStat["status"]): string {
  if (status === "optimal") return "#22c55e"
  if (status === "degraded") return "#f59e0b"
  return "#ef4444"
}

function summarize(networks: NetworkHealthStat[]): string {
  const withData = networks.filter((n) => n.status !== "no_data")
  if (withData.length === 0) return "No recent data"
  const optimalCount = withData.filter((n) => n.status === "optimal").length
  return optimalCount === withData.length ? "All Gateways Optimal" : `${optimalCount}/${withData.length} Gateways Optimal`
}

export function NetworkHealthCard({ networks, loading, onRefresh }: NetworkHealthCardProps) {
  return (
    <div className="rounded-2xl border border-[#e5e9f5] bg-white p-4 sm:p-5">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#e7f7ef] text-[#0f7a4d]">
          <Activity className="w-5 h-5" />
        </span>
        <div className="min-w-0">
          <p className="text-[15px] font-bold text-[#1e2537]">Telecom Gateway Health &amp; Ping Radar</p>
          <p className="text-xs font-medium text-[#0f7a4d]">
            {networks.length > 0 ? summarize(networks) : "Last 24 hours"} &middot; Automated Routing
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-[#e5e9f5] px-3.5 py-1.5 text-xs font-bold text-[#1e2537] hover:bg-[#f7f8fc] disabled:opacity-50"
      >
        <Zap className={`w-3.5 h-3.5 text-[#f2a900] ${loading ? "animate-pulse" : ""}`} /> Test Ping
      </button>

      {loading && networks.length === 0 ? (
        <div className="p-4 text-center text-sm text-[#6b7280]">Loading...</div>
      ) : (
        <div className="mt-3 space-y-3">
          {networks.map((stat) => {
            const badge = NETWORK_BADGE[stat.network]
            if (stat.status === "no_data" || stat.uptimePercent === null) {
              // No fabricated 0% -- 0% would claim "completely down", a
              // different, false claim from "we have no data yet".
              return (
                <div key={stat.network} className="rounded-xl bg-[#eef2ff] p-3.5">
                  <div className="flex items-center gap-2">
                    <span className={`flex h-8 w-8 items-center justify-center rounded-full text-[10px] font-extrabold ${badge.className}`}>
                      {badge.text}
                    </span>
                    <span className="text-sm font-bold text-[#1e2537]">{stat.network} Gateway</span>
                  </div>
                  <p className="mt-2 text-[11px] text-[#6b7280]">No recent data</p>
                </div>
              )
            }
            const width = Math.max(0, Math.min(100, stat.uptimePercent))
            return (
              <div key={stat.network} className="rounded-xl bg-[#eef2ff] p-3.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`flex h-8 w-8 items-center justify-center rounded-full text-[10px] font-extrabold ${badge.className}`}>
                      {badge.text}
                    </span>
                    <span className="text-sm font-bold text-[#1e2537]">{stat.network} Gateway</span>
                  </div>
                  {stat.avgDeliveryMinutes !== null && (
                    <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-bold text-[#1e2537]">
                      {stat.avgDeliveryMinutes < 60 ? `${stat.avgDeliveryMinutes}m` : `${Math.floor(stat.avgDeliveryMinutes / 60)}h`}
                    </span>
                  )}
                </div>
                <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-white">
                  <div className="h-full rounded-full" style={{ width: `${width}%`, backgroundColor: barColor(stat.status) }} />
                </div>
                <div className="mt-2 flex items-center justify-between text-[11px] text-[#4b5563]">
                  <span>
                    Status: <span className="font-bold capitalize text-[#0f7a4d]">{stat.status}</span>
                  </span>
                  <span>Uptime: {stat.uptimePercent.toFixed(1)}%</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
