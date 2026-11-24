import type { CatalogEntry } from "./types"
import { ORDERS_ENTRIES } from "./areas/orders"
import { FULFILLMENT_ENTRIES } from "./areas/fulfillment"
import { USERS_ENTRIES } from "./areas/users"
import { MONEY_ENTRIES } from "./areas/money"
import { SETTINGS_ENTRIES } from "./areas/settings"
import { SERVICES_ENTRIES } from "./areas/services"

// Each area task adds its exported entry array here: CATALOG = [...ORDERS_ENTRIES, ...NEXT_ENTRIES]
export const CATALOG: CatalogEntry[] = [...ORDERS_ENTRIES, ...FULFILLMENT_ENTRIES, ...USERS_ENTRIES, ...MONEY_ENTRIES, ...SETTINGS_ENTRIES, ...SERVICES_ENTRIES]

export function getEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id)
}

export function searchEntries(
  list: CatalogEntry[],
  query: string,
  page?: string,
  limit = 8,
): CatalogEntry[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  return list
    .filter((e) => (page ? e.page === page : true))
    .filter((e) => {
      const hay = `${e.id} ${e.pageTitle} ${e.summary} ${e.page}`.toLowerCase()
      return tokens.every((t) => hay.includes(t))
    })
    .slice(0, limit)
}

export function searchCatalog(query: string, page?: string, limit = 8): CatalogEntry[] {
  return searchEntries(CATALOG, query, page, limit)
}
