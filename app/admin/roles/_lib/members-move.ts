import type { HubRole } from "./ladder-view"

export const MAX_SELECT = 5000
export const MOVE_CHUNK = 200

export interface MoveResult {
  user_id: string
  status: "moved" | "skipped" | "error"
  reason?: string
  note?: string
}

export interface Tally {
  moved: number
  skipped: number
  errors: number
}

export const emptyTally = (): Tally => ({ moved: 0, skipped: 0, errors: 0 })

export function addTally(t: Tally, results: readonly MoveResult[]): Tally {
  const out = { ...t }
  for (const r of results) {
    if (r.status === "moved") out.moved++
    else if (r.status === "skipped") out.skipped++
    else out.errors++
  }
  return out
}

export const tallyText = (t: Tally) => `moved ${t.moved}, skipped ${t.skipped}, errors ${t.errors}`

/** Move targets: User, Dealer and live custom roles. Never admin, sub_agent, archived or the current role. */
export function moveTargets(roles: readonly HubRole[], currentRoleId: string): HubRole[] {
  return roles.filter(
    (r) => !r.archived_at && r.id !== currentRoleId && r.slug !== "admin" && r.slug !== "sub_agent",
  )
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Walks pages of the member search collecting ids; stops at `cap` ids (capped = true if more matched). */
export async function collectAllIds(
  fetchPage: (page: number) => Promise<{ ids: string[]; total: number }>,
  _pageSize: number,
  cap: number = MAX_SELECT,
): Promise<{ ids: string[]; capped: boolean }> {
  const ids: string[] = []
  const seen = new Set<string>()
  let capped = false
  for (let page = 1; page <= 1000; page++) {
    const r = await fetchPage(page)
    if (r.ids.length === 0) break
    for (const id of r.ids) {
      if (seen.has(id)) continue
      if (ids.length >= cap) {
        capped = true
        break
      }
      seen.add(id)
      ids.push(id)
    }
    if (capped) break
    if (ids.length >= r.total) break
    if (ids.length >= cap) {
      capped = r.total > cap
      break
    }
  }
  return { ids, capped }
}
