"use client"

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

// Colors sampled directly from the Apex Prime reference screenshot rather
// than this app's semantic tokens (--success etc.), per explicit direction
// to match the reference's own palette on this page.
export function LatestOrderCard({ order, loading, onRefresh }: LatestOrderCardProps) {
  return (
    <div className="rounded-2xl border border-[#a5dccb] bg-[#eaf5f4] p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#0f7a4d] text-white">
            <CheckCircle2 className="w-5 h-5" />
          </span>
          <span className="truncate text-[15px] font-bold text-[#1e2537]">
            {order ? `Latest ${order.network} Successful Order` : "Latest Successful Order"}
          </span>
        </div>
        <button
          type="button"
          aria-label="Refresh"
          onClick={onRefresh}
          disabled={loading}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#0f7a4d] hover:bg-[#0f7a4d]/10 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {loading ? (
        <div className="py-6 text-center text-sm text-[#4b5563]">Loading...</div>
      ) : !order ? (
        <div className="py-6 text-center text-sm text-[#4b5563]">No completed orders yet</div>
      ) : (
        <div className="mt-3 space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            {order.durationMinutes !== null && (
              <span
                className="rounded-full bg-white px-3 py-1 text-xs font-bold text-[#0f7a4d]"
                title="Time from when this order was sent to the network provider to when it completed — not from when you placed it."
              >
                Took {formatDuration(order.durationMinutes)}
              </span>
            )}
            {order.avgNetworkDurationMinutes !== null && (
              <span
                className="rounded-full border border-[#a5dccb] bg-white/60 px-3 py-1 text-xs font-semibold text-[#1e2537]"
                title={`Average delivery time across other recent ${order.network} orders on the platform in the last 24h — not specific to this order.`}
              >
                {order.network} avg: ~{formatDuration(order.avgNetworkDurationMinutes)}
              </span>
            )}
            {order.isNight && (
              <span className="flex items-center gap-1 rounded-full border border-[#a5dccb] bg-white/60 px-3 py-1 text-xs font-semibold text-[#1e2537]">
                <Moon className="w-3 h-3" /> Night
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-[#3f4b56]">
            <Clock className="w-3.5 h-3.5" />
            <span>Placed: {formatTimestamp(order.createdAt)}</span>
            {order.completedAt && (
              <>
                <span>•</span>
                <span className="flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5 text-[#0f7a4d]" /> Completed: {formatTimestamp(order.completedAt)}
                </span>
              </>
            )}
          </div>

          {order.hasHeldOrder && (
            <div className="flex items-start gap-2 rounded-lg border border-[#fdf4d0] bg-[#fffbec] p-3 text-xs text-[#7d5a00]">
              <Info className="w-4 h-4 mt-0.5 shrink-0 text-[#b45503]" />
              <span>
                An order is currently pending an MTN number-validation check. This can add extra time before it completes.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
