import { cn } from '@/lib/utils'
import { gatewayStatus, gatewayBarColorClass, networkBadgeClasses, type GatewayNetwork } from '@/lib/admin-theme'

export function GatewayHealthCard({
  label,
  badgeText,
  network,
  badgeClassName,
  latencyMs,
  uptimePct,
  className,
}: {
  label: string
  badgeText: string
  network?: GatewayNetwork
  badgeClassName?: string
  latencyMs: number
  uptimePct: number
  className?: string
}) {
  const status = gatewayStatus(uptimePct)
  const barClass = gatewayBarColorClass(status)
  const barWidth = Math.max(0, Math.min(100, uptimePct))
  const badgeClasses = network
    ? networkBadgeClasses(network)
    : badgeClassName ?? 'bg-admin-accent text-white'

  return (
    <div className={cn('flex-1 rounded-xl border border-border p-3.5', className)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={cn('flex h-6 w-6 items-center justify-center rounded-md text-[8px] font-extrabold', badgeClasses)}>
            {badgeText}
          </div>
          <span className="text-sm font-semibold text-foreground">{label}</span>
        </div>
        <span className="text-xs text-muted-foreground">{latencyMs}ms</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-border">
        <div className={cn('h-full rounded-full', barClass)} style={{ width: `${barWidth}%` }} />
      </div>
      <div className="mt-2 text-[11px] text-muted-foreground">
        Status: <span className="font-bold capitalize">{status}</span> · Uptime {uptimePct.toFixed(1)}%
      </div>
    </div>
  )
}
