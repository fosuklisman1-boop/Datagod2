// Page through a paged list until every match is collected.
// Used by the users page export and adminUserService.getAllUsers.

export interface PagedResult<T> {
  users: T[]
  total: number
}

/**
 * Calls fetchPage(1), fetchPage(2), ... until `total` rows are collected or a
 * page comes back short/empty. Rows are de-duplicated by id: with offset paging
 * a signup during the export shifts rows down one, which would otherwise repeat
 * a row at a page boundary. Stops after maxPages as a safety net.
 */
export async function collectAllPages<T extends { id: string }>(
  fetchPage: (page: number) => Promise<PagedResult<T>>,
  opts: { pageSize: number; maxPages?: number; onProgress?: (loaded: number, total: number) => void },
): Promise<T[]> {
  const maxPages = opts.maxPages ?? 1000
  const seen = new Set<string>()
  const out: T[] = []
  for (let page = 1; page <= maxPages; page++) {
    const { users, total } = await fetchPage(page)
    for (const u of users) {
      if (seen.has(u.id)) continue
      seen.add(u.id)
      out.push(u)
    }
    opts.onProgress?.(out.length, total)
    if (users.length < opts.pageSize || page * opts.pageSize >= total) break
  }
  return out
}
