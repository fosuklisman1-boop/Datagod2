import type { HubtelCsServiceKey } from "@/lib/hubtel-cs/services"
import type { HubtelQueryItem } from "@/lib/hubtel-cs/types"
import {
  CATEGORY_ORDER, NETWORK_SERVICE, OTHER_CATEGORY, parseCatalog,
  type BundleNetwork, type CatalogBundle,
} from "./categories"
import type { BundlesConfig } from "./config"
import { signBundleToken } from "./token"

export const CATALOG_CACHE_TTL_MS = 10 * 60_000

export interface CatalogDeps {
  getBundlesConfig(): Promise<BundlesConfig>
  getHubtelConfig(): Promise<{ enabled: boolean; paused: boolean; services: Record<string, boolean> }>
  query(serviceKey: HubtelCsServiceKey, destination: string, params?: { mobile?: string }):
    Promise<{ ok: true; data: HubtelQueryItem[] } | { ok: false; error: string; code?: string }>
  secret: string
  now(): number
}

export type SignedBundle = CatalogBundle & { token: string }
export type CatalogResult =
  | { ok: true; categories: { name: string; bundles: SignedBundle[] }[] }
  | { ok: false; status: number; error: string }

const fail = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error })
const UNAVAILABLE = "Bundles unavailable right now"

const cache = new Map<BundleNetwork, { bundles: CatalogBundle[]; fetchedAt: number }>()

export function __resetCatalogCache(): void { cache.clear() }

export async function getCatalog(d: CatalogDeps, network: BundleNetwork): Promise<CatalogResult> {
  if (!d.secret) return fail(503, UNAVAILABLE)
  let cfg: BundlesConfig
  try { cfg = await d.getBundlesConfig() } catch { return fail(503, UNAVAILABLE) }
  const net = cfg.networks[network]
  if (!cfg.enabled || !net?.enabled) return fail(403, "Standard Bundles are not available")

  const serviceKey = NETWORK_SERVICE[network]
  try {
    const h = await d.getHubtelConfig()
    if (!h.enabled || h.services?.[serviceKey] !== true) return fail(503, UNAVAILABLE)
  } catch { return fail(503, UNAVAILABLE) }

  const now = d.now()
  let entry = cache.get(network)
  if (!entry || now - entry.fetchedAt >= CATALOG_CACHE_TTL_MS || now < entry.fetchedAt) {
    let res: Awaited<ReturnType<CatalogDeps["query"]>>
    try { res = await d.query(serviceKey, net.referenceNumber) } catch { return fail(503, UNAVAILABLE) }
    if (!res.ok) return fail(503, UNAVAILABLE)
    entry = { bundles: parseCatalog(network, res.data), fetchedAt: now }
    cache.set(network, entry)
  }

  const hidden = new Set(net.hiddenCategories)
  const order = [...CATEGORY_ORDER[network]]
  const groups = new Map<string, SignedBundle[]>()
  for (const b of entry.bundles) {
    if (hidden.has(b.category)) continue
    const signed: SignedBundle = {
      ...b,
      token: signBundleToken(
        { network, value: b.value, amount: b.amount, display: b.display, category: b.category, issuedAt: now },
        d.secret,
      ),
    }
    const list = groups.get(b.category)
    if (list) list.push(signed); else groups.set(b.category, [signed])
  }
  const names = [
    ...order.filter(n => groups.has(n)),
    ...[...groups.keys()].filter(n => !order.includes(n) && n !== OTHER_CATEGORY),
    ...(groups.has(OTHER_CATEGORY) ? [OTHER_CATEGORY] : []),
  ]
  return { ok: true, categories: names.map(name => ({ name, bundles: groups.get(name)! })) }
}
