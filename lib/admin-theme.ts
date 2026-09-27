// Class-name mappings and small status-derivation helpers backing the admin reskin's presentational components.

export type StatusPillVariant = 'success' | 'warning' | 'danger'

export function statusPillClasses(variant: StatusPillVariant): string {
  switch (variant) {
    case 'success':
      return 'bg-success/10 text-success border border-success/30'
    case 'warning':
      return 'bg-warning/10 text-warning border border-warning/30'
    case 'danger':
      return 'bg-destructive/10 text-destructive border border-destructive/30'
  }
}

export function segmentedPillItemClasses(isActive: boolean): string {
  return isActive
    ? 'bg-admin-amber text-slate-900 font-bold'
    : 'bg-transparent text-current font-medium hover:bg-white/10'
}

export type GatewayStatus = 'optimal' | 'degraded' | 'down'

export function gatewayStatus(uptimePct: number): GatewayStatus {
  if (uptimePct >= 99) return 'optimal'
  if (uptimePct >= 90) return 'degraded'
  return 'down'
}

export function gatewayBarColorClass(status: GatewayStatus): string {
  switch (status) {
    case 'optimal':
      return 'bg-success'
    case 'degraded':
      return 'bg-warning'
    case 'down':
      return 'bg-destructive'
  }
}

export type GatewayNetwork = 'mtn' | 'telecel' | 'at'

const NETWORK_BADGE_CLASSES: Record<GatewayNetwork, string> = {
  mtn: 'bg-mtn text-mtn-foreground',
  telecel: 'bg-telecel text-telecel-foreground',
  at: 'bg-at text-at-foreground',
}

export function networkBadgeClasses(network: GatewayNetwork): string {
  return NETWORK_BADGE_CLASSES[network]
}
