import { gatewayStatus, gatewayBarColorClass } from '@/lib/admin-theme'

export function GatewayHealthCard({
  label,
  badgeText,
  badgeBg,
  badgeFg,
  latencyMs,
  uptimePct,
}: {
  label: string
  badgeText: string
  badgeBg: string
  badgeFg: string
  latencyMs: number
  uptimePct: number
}) {
  const status = gatewayStatus(uptimePct)
  const barClass = gatewayBarColorClass(status)
  const barWidth = Math.max(0, Math.min(100, uptimePct))

  return (
    <div className="flex-1 rounded-xl border border-border p-3.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className="flex h-6 w-6 items-center justify-center rounded-md text-[8px] font-extrabold"
            style={{ background: badgeBg, color: badgeFg }}
          >
            {badgeText}
          </div>
          <span className="text-sm font-semibold text-foreground">{label}</span>
        </div>
        <span className="text-xs text-muted-foreground">{latencyMs}ms</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-border">
        <div className={`h-full rounded-full ${barClass}`} style={{ width: `${barWidth}%` }} />
      </div>
      <div className="mt-2 text-[11px] text-muted-foreground">
        Status: <span className="font-bold capitalize">{status}</span> · Uptime {uptimePct}%
      </div>
    </div>
  )
}
