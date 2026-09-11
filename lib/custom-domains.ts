export type DomainService = "data_bundles" | "airtime" | "results_checker" | "bulk_sms"

export interface CustomDomainConfig {
  domain: string
  service: DomainService
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

/**
 * Returns a service's own first/primary path — the target used both as the
 * fallback redirect destination in getServiceRedirect below and as the mobile
 * bottom-nav FAB's repointed href when a domain is scoped to this service.
 */
export function getServicePrimaryPath(service: DomainService): string {
  return SERVICE_PATH_PREFIXES[service][0]
}

/**
 * Given the requested path and the domain's chosen service, return the path to
 * redirect to if this path belongs to a DIFFERENT service's family, else null
 * (the path is either service-agnostic — wallet, orders, auth, admin — or
 * already belongs to this domain's own service).
 */
export function getServiceRedirect(path: string, service: DomainService): string | null {
  const ownPrefixes = SERVICE_PATH_PREFIXES[service]
  // Defensive: an unrecognized service value should never crash rendering (e.g.
  // a stale cached/header value referencing a since-removed service) — treat it
  // as "no restriction" rather than throwing on the SERVICE_PATH_PREFIXES miss.
  if (!ownPrefixes) return null
  if (ownPrefixes.some(p => path.startsWith(p))) return null

  const belongsToOtherService = (Object.entries(SERVICE_PATH_PREFIXES) as [DomainService, string[]][])
    .some(([s, prefixes]) => s !== service && prefixes.some(p => path.startsWith(p)))
  if (!belongsToOtherService) return null

  return getServicePrimaryPath(service)
}

/** Convenience wrapper for nav filtering: true when `path` should be shown for `service`. */
export function isPathAllowedForService(path: string, service: DomainService | null): boolean {
  if (!service) return true
  return getServiceRedirect(path, service) === null
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
