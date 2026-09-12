export type DomainService = "data_bundles" | "airtime" | "results_checker" | "bulk_sms"

export interface CustomDomainConfig {
  domain: string
  services: DomainService[]
  site_name: string
  logo_url: string | null
  primary_color: string | null
  is_active: boolean
}

const SERVICE_PATH_PREFIXES: Record<DomainService, string[]> = {
  data_bundles: ["/dashboard/data-packages"],
  airtime: ["/dashboard/airtime"],
  results_checker: ["/dashboard/results-checker", "/dashboard/results-check"],
  bulk_sms: ["/dashboard/sms"],
}

// Dealer/business-management tools that aren't tied to any one of the four
// core services — hidden and blocked on any branded domain, regardless of
// which services are selected, unless a selected service's own path already
// covers the route (e.g. bulk_sms already covers /dashboard/sms).
const NON_SERVICE_GATED_PATHS = [
  "/dashboard/afa-orders",
  "/dashboard/upgrade",
  "/dashboard/my-shop",
  "/dashboard/shop-dashboard",
  "/dashboard/sub-agents",
  "/dashboard/sub-agent-catalog",
  "/dashboard/ussd-shop",
  "/dashboard/payment-reverify",
  "/dashboard/buy-stock",
]

/**
 * Returns a service's own first/primary path — the target used both as the
 * fallback redirect destination in getServiceRedirect below and as the mobile
 * bottom-nav FAB's repointed href when a domain is scoped to this service.
 */
export function getServicePrimaryPath(service: DomainService): string {
  return SERVICE_PATH_PREFIXES[service][0]
}

/**
 * Given the requested path and the domain's selected services, return the
 * path to redirect to if this path belongs to a service NOT selected, or to
 * a non-service dealer/business-management route, else null (the path is
 * either account-wide — wallet, orders, auth, admin — or already belongs to
 * one of this domain's own selected services).
 */
export function getServiceRedirect(path: string, services: DomainService[]): string | null {
  if (!services || services.length === 0) return null

  // Recognized-service check first, filtering out any unrecognized value
  // defensively (e.g. a stale cached/header entry referencing a since-removed
  // service) so it never crashes rendering.
  const validServices = services.filter(s => SERVICE_PATH_PREFIXES[s])
  if (validServices.length === 0) return null

  const ownPrefixes = validServices.flatMap(s => SERVICE_PATH_PREFIXES[s])
  if (ownPrefixes.some(p => path.startsWith(p))) return null

  const belongsToOtherService = (Object.entries(SERVICE_PATH_PREFIXES) as [DomainService, string[]][])
    .some(([s, prefixes]) => !validServices.includes(s) && prefixes.some(p => path.startsWith(p)))
  const belongsToNonServiceGated = NON_SERVICE_GATED_PATHS.some(p => path.startsWith(p))
  if (!belongsToOtherService && !belongsToNonServiceGated) return null

  return getServicePrimaryPath(validServices[0])
}

/** Convenience wrapper for nav filtering: true when `path` should be shown for `services`. */
export function isPathAllowedForService(path: string, services: DomainService[] | null): boolean {
  if (!services || services.length === 0) return true
  return getServiceRedirect(path, services) === null
}

export function normalizeDomainHost(host: string | null): string | null {
  if (!host) return null
  return host.split(":")[0].toLowerCase()
}

/**
 * Converts a 6-digit hex color to the "H S% L%" triplet format used by the
 * shadcn-style CSS custom properties in app/globals.css (e.g. "160 84% 30%").
 * Returns null for anything that isn't a valid 6-digit hex color.
 */
export function hexToHslTriplet(hex: string): string | null {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!match) return null

  const int = parseInt(match[1], 16)
  const r = ((int >> 16) & 255) / 255
  const g = ((int >> 8) & 255) / 255
  const b = (int & 255) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2

  let h = 0
  let s = 0
  const delta = max - min
  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min)
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
    h *= 60
    if (h < 0) h += 360
  }

  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`
}

/**
 * True if `domain` collides with the main app's own host shape — the exact
 * root domain, or a `<label>.<root>` shop-subdomain shape (see
 * getShopSubdomain in middleware.ts, which treats ANY single-label subdomain
 * of the root domain as shop-storefront territory) — which is already claimed
 * by existing routing and can never be assigned as a custom domain.
 */
export function isReservedDomainHost(domain: string, rootDomain: string): boolean {
  const host = domain.toLowerCase()
  const root = rootDomain.toLowerCase()
  if (host === root) return true
  if (host.endsWith(`.${root}`)) {
    const label = host.slice(0, -(`.${root}`.length))
    if (label && !label.includes(".")) return true
  }
  return false
}
