/**
 * Endpoint -> service map for the per-service pause (spec 6.4). Service ids equal DocSlug of docs/pages.ts
 * (a test keeps them in sync). Mapping is by path prefix on the `endpoint` literal each route passes to the
 * handler, so no route file changes. account and wallet are never pausable: a developer must always be able
 * to see their balance and role.
 */

export type ServiceId = "data" | "airtime" | "bills" | "bundles" | "results" | "afa" | "sms"

export const SERVICES: readonly { id: ServiceId; title: string }[] = [
  { id: "data", title: "Data and wallet" },
  { id: "airtime", title: "Airtime" },
  { id: "bills", title: "Utility bills" },
  { id: "bundles", title: "Standard Bundles" },
  { id: "results", title: "Results checker" },
  { id: "afa", title: "AFA registration" },
  { id: "sms", title: "SMS" },
]

const PREFIXES: readonly (readonly [string, ServiceId])[] = [
  ["/api/v2/data", "data"],
  ["/api/v2/packages", "data"],
  ["/api/v2/orders", "data"],
  ["/api/v2/airtime", "airtime"],
  ["/api/v2/utilities", "bills"],
  ["/api/v2/bundles", "bundles"],
  ["/api/v2/resultschecker", "results"],
  ["/api/v2/afa", "afa"],
  ["/api/v2/sms", "sms"],
]

/** null = never pausable (account, wallet) or unknown. Matches whole path segments only. */
export function serviceForEndpoint(endpoint: string): ServiceId | null {
  for (const [prefix, id] of PREFIXES) {
    if (endpoint === prefix || endpoint.startsWith(prefix + "/")) return id
  }
  return null
}

/** Section 6.4 call: a service pause blocks writes only; order lookups stay up. One-line change to flip. */
export const PAUSE_BLOCKS_READS = false

export function blocksMethod(method: string): boolean {
  const m = method.toUpperCase()
  if (!PAUSE_BLOCKS_READS && (m === "GET" || m === "HEAD")) return false
  return true
}
