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
  const links: HomeServiceLinks = { all: "/services" }
  if (on("mtn-data") || on("telecel-data") || on("at-data")) links.data = "/services#data"
  for (const [card, key] of BY_PRODUCT) {
    if (on(key)) links[card] = getProduct(key).path
  }
  return links
}
