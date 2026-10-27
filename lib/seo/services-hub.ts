/**
 * Pure helpers for the /services hub: which products to show, grouped, and the
 * ItemList JSON-LD over them. No I/O.
 */
import { absoluteUrl } from "./site"
import { PRODUCTS, type ProductEntry, type ProductGroup } from "./products"
import type { LiveFacts } from "./live-facts"

export interface ServiceGroup {
  group: ProductGroup
  label: string
  /** DOM id, so /services#data works. */
  anchor: string
  items: ProductEntry[]
}

/** Display order. AFA registration is registry group "data", so it sits under data. */
const GROUPS: ReadonlyArray<{ group: ProductGroup; label: string }> = [
  { group: "data", label: "Data bundles & AFA" },
  { group: "airtime", label: "Airtime" },
  { group: "bills", label: "Bill payments" },
  { group: "education", label: "Results checkers" },
  { group: "business", label: "For businesses & resellers" },
  { group: "channels", label: "Ways to order" },
]

/** Live products grouped for display; items keep registry order, empty groups are dropped. */
export function groupAvailableProducts(facts: LiveFacts): ServiceGroup[] {
  return GROUPS.map(({ group, label }) => ({
    group,
    label,
    anchor: group,
    items: PRODUCTS.filter((p) => p.group === group && facts.products[p.key]?.available === true),
  })).filter((g) => g.items.length > 0)
}

export function buildItemListJsonLd(groups: readonly ServiceGroup[]): object {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: groups
      .flatMap((g) => g.items)
      .map((p, i) => ({ "@type": "ListItem", position: i + 1, url: absoluteUrl(p.path), name: p.name })),
  }
}
