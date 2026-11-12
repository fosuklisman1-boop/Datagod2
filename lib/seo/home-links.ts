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
import { atTypeOf } from "./data-prices"
import { availableLandings } from "./landing-pages"
import { publishedGuides, type Guide } from "./guides"

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
  ["cheapest-data", "Cheapest data in Ghana"],
  ["airtime", "Airtime"],
  ["utility-bills", "Utility bills"],
  ["results-checker", "Results checker"],
  ["afa-registration", "MTN AFA registration"],
  // "Open a reseller shop": the "Become a data reseller" anchor goes to the guide (/become-a-data-reseller).
  ["join", "Open a reseller shop"],
]

/**
 * Footer "Buy online" block: the live product pages above, then the live
 * landing pages (lib/seo/landing-pages.ts, registry order, footerLabel),
 * then the guides hub (lib/seo/guides.ts) when a guide is published.
 */
export function homeFooterLinks(
  facts: LiveFacts,
  isMainSite: boolean,
  guides: readonly Guide[] = publishedGuides(),
): HomeLink[] {
  if (!isMainSite) return []
  return [
    ...FOOTER.filter(([k]) => facts.products[k]?.available === true).map(([k, label]) => ({ label, href: getProduct(k).path })),
    ...availableLandings(facts).map((e) => ({ label: e.footerLabel, href: e.path })),
    ...(guides.length > 0 ? [{ label: "Guides", href: "/guides" }] : []),
  ]
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
 * "Popular Data Packages": the cheapest bundle per network (and per AT
 * product) from the adjusted customer price lists (LiveFacts.prices, the
 * prices the network pages and the dashboard show). Empty when the prices
 * could not be read.
 */
export function homePopularPackages(facts: LiveFacts, isMainSite: boolean): PopularPackage[] {
  const out: PopularPackage[] = []
  for (const net of ["MTN", "Telecel", "AT"] as const) {
    const key = NET_KEY[net]
    const linked = isMainSite && facts.products[key]?.available === true
    for (const g of facts.prices?.[net] ?? []) {
      const cheapest = g.rows.reduce<(typeof g.rows)[number] | null>((m, r) => (m === null || r.price < m.price ? r : m), null)
      if (!cheapest) continue
      const type = atTypeOf(g.network)
      out.push({
        network: type ? `${net} ${type}` : net,
        size: cheapest.label,
        price: cheapest.price,
        ...(linked && { href: getProduct(key).path }),
      })
    }
  }
  return out
}
