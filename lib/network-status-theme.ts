// Class-name mappings and status-derivation helpers backing GatewayHealthCard.
// Genuinely shared (not admin-specific) -- used on the admin dashboard and,
// as of the customer-dashboard rebuild, on /dashboard's Network Health card
// too. Moved out of admin-theme.ts once it got a second, non-admin caller.

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

// 'bigtime' has no dedicated CSS custom property (unlike mtn/telecel/at,
// which are real design tokens) -- it's a single-badge accent, not a color
// reused across the app, so a raw Tailwind utility is the right-sized choice
// here rather than adding a new token for one usage.
export type GatewayNetwork = 'mtn' | 'telecel' | 'at' | 'bigtime'

const NETWORK_BADGE_CLASSES: Record<GatewayNetwork, string> = {
  mtn: 'bg-mtn text-mtn-foreground',
  telecel: 'bg-telecel text-telecel-foreground',
  at: 'bg-at text-at-foreground',
  bigtime: 'bg-violet-600 text-white',
}

export function networkBadgeClasses(network: GatewayNetwork): string {
  return NETWORK_BADGE_CLASSES[network]
}
