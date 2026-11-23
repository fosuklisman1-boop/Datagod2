import type { CatalogEntry } from "./types"

export const CATALOG: CatalogEntry[] = []

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
