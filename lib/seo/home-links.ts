/**
 * Where each homepage service card links to. Pure.
 *
 * Only on the main site: product pages 404 on custom domains / shop hosts,
 * and a restricted domain must not promote Datagod products, so off the main
 * host no card is linked (the homepage looks exactly as before there).
 * A card whose product is switched off is left unlinked rather than pointing
 * at a 404.
 */
import type { LiveFacts } from "./live-facts"
import { getProduct, type ProductKey } from "./products"
import { availableEntries } from "./page-meta"
import { cheapestRows } from "./data-prices"

export type HomeLinkKey =
  | "data" | "airtime" | "afa" | "bills" | "results" | "results-service"
  | "bulk-sms" | "shops" | "sub-agents" | "developers" | "anywhere" | "all"

export type HomeServiceLinks = Partial<Record<HomeLinkKey, string>>

const BY_PRODUCT: Array<[HomeLinkKey, ProductKey]> = [
  ["airtime", "airtime"],
  ["afa", "afa-registration"],
  ["bills", "utility-bills"],
  ["results", "results-checker"],
  ["results-service", "results-checker"],
  ["bulk-sms", "bulk-sms"],
  ["shops", "join"],
  ["sub-agents", "join"],
  ["developers", "developers"],
  ["anywhere", "ussd"],
]

export function homeServiceLinks(facts: LiveFacts, isMainSite: boolean): HomeServiceLinks {
  if (!isMainSite) return {}
  const on = (k: ProductKey) => facts.products[k]?.available === true
  // The Data Bundles card links per network instead (homeDataNetworkLinks chips).
  const links: HomeServiceLinks = { all: "/services" }
  for (const [card, key] of BY_PRODUCT) {
    if (on(key)) links[card] = getProduct(key).path
  }
  return links
}

export interface HomeLink { label: string; href: string }

const DATA_KEYS: readonly ProductKey[] = ["mtn-data", "telecel-data", "at-data"]

/** Network chips on the Data Bundles card: one per live data network page (main site only). */
export function homeDataNetworkLinks(facts: LiveFacts, isMainSite: boolean): HomeLink[] {
  if (!isMainSite) return []
  return availableEntries(DATA_KEYS, facts).map((p) => ({ label: p.network as string, href: p.path }))
}

/** Footer "Buy online" block, registry order of this list; switched-off products are left out. */
const FOOTER: ReadonlyArray<[ProductKey, string]> = [
  ["mtn-data", "MTN data"],
  ["telecel-data", "Telecel data"],
  ["at-data", "AT data"],
  ["airtime", "Airtime"],
  ["utility-bills", "Utility bills"],
  ["results-checker", "Results checker"],
  ["afa-registration", "MTN AFA registration"],
  ["join", "Become an agent"],
]

export function homeFooterLinks(facts: LiveFacts, isMainSite: boolean): HomeLink[] {
  if (!isMainSite) return []
  return FOOTER.filter(([k]) => facts.products[k]?.available === true).map(([k, label]) => ({ label, href: getProduct(k).path }))
}

export interface PopularPackage {
  /** "MTN", "AT iShare" */
  network: string
  size: string
  price: number
  /** The network page; unset off the main site or when that page is off. */
  href?: string
}

const NET_KEY = { MTN: "mtn-data", Telecel: "telecel-data", AT: "at-data" } as const

/**
 * "Popular Data Packages": the cheapest bundle per network (and AT type) from
 * the public price tables (packages.price). Empty when the packages read failed.
 */
export function homePopularPackages(facts: LiveFacts, isMainSite: boolean): PopularPackage[] {
  if (!facts.dataPrices) return []
  return cheapestRows(facts.dataPrices).map((r) => {
    const key = NET_KEY[r.network]
    const linked = isMainSite && facts.products[key]?.available === true
    return {
      network: r.type ? `${r.network} ${r.type}` : r.network,
      size: r.size,
      price: r.price,
      ...(linked && { href: getProduct(key).path }),
    }
  })
}
