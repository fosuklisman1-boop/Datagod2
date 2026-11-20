import type { HubRole } from "./ladder-view"

export const MAX_SELECT = 5000
export const MOVE_CHUNK = 200

export interface MoveResult {
  user_id: string
  status: "moved" | "skipped" | "error" | "unknown" | "not_attempted"
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
    else if (r.status === "error") out.errors++
  }
  return out
}

export const UNKNOWN_REASON = "Request failed — check the members list; some may have moved."
export const NOT_ATTEMPTED_REASON = "Not sent because an earlier request failed."

export const extraCounts = (results: readonly MoveResult[]) => ({
  unknown: results.filter((r) => r.status === "unknown").length,
  notAttempted: results.filter((r) => r.status === "not_attempted").length,
})

/** Failures after which more requests would only hammer (or whose outcome is unknown). */
function stopsLoop(e: unknown): boolean {
  const s = (e as { status?: unknown } | null)?.status
  if (typeof s !== "number") return true // network / fetch failure
  return s === 401 || s === 403 || s === 429 || s >= 500
}

/**
 * Sends ids in chunks, sequentially. Per-user results (including skipped/error rows) never stop it. A 401, 403, 429,
 * 5xx or network failure stops it: that chunk becomes "unknown" (it may have been applied), the rest "not_attempted".
 * Other 4xx failures mark the chunk "error" and continue.
 */
export async function runMoveChunks(
  ids: readonly string[],
  send: (chunkIds: string[]) => Promise<MoveResult[]>,
  onProgress?: (all: MoveResult[]) => void,
  size: number = MOVE_CHUNK,
): Promise<{ results: MoveResult[]; stop: { status: number | null; message: string } | null }> {
  const chunks = chunk(ids, size)
  let all: MoveResult[] = []
  for (let i = 0; i < chunks.length; i++) {
    try {
      all = all.concat(await send(chunks[i]))
    } catch (e) {
      const message = e instanceof Error ? e.message : "Request failed"
      if (stopsLoop(e)) {
        const status = (e as { status?: unknown }).status
        all = all.concat(chunks[i].map((user_id) => ({ user_id, status: "unknown" as const, reason: UNKNOWN_REASON })))
        for (const rest of chunks.slice(i + 1)) {
          all = all.concat(rest.map((user_id) => ({ user_id, status: "not_attempted" as const, reason: NOT_ATTEMPTED_REASON })))
        }
        onProgress?.(all)
        return { results: all, stop: { status: typeof status === "number" ? status : null, message } }
      }
      all = all.concat(chunks[i].map((user_id) => ({ user_id, status: "error" as const, reason: message })))
    }
    onProgress?.(all)
  }
  return { results: all, stop: null }
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
