/**
 * Owner/dealer view of blocked MTN numbers (spec sections 6 and 6b).
 * Figures are computed from the attempts passed in, so a shop only ever sees
 * its own attempts; only the status comes from the shared number row.
 */

import { DEALER_SURFACES, type BlockSurface } from "./types"

export type AttemptRow = {
  phone: string
  surface: string
  product: string | null
  created_at: string
}

export type NumberRow = { status: string }

export type UserStatus = "waiting" | "ready" | "expired"

export type UserBlockedRow = {
  phone: string
  firstTried: string
  lastTried: string
  attempts: number
  products: string[]
  surfaces: BlockSurface[]
  status: UserStatus
}

export const USER_PAGE_SIZE = 50
export const USER_ATTEMPT_READ_LIMIT = 10_000
export const USER_EXPORT_LIMIT = 10_000

function mapStatus(s: string | undefined): UserStatus {
  if (s === "allowed") return "ready"
  if (s === "expired" || s === "handled") return "expired"
  return "waiting"
}

export function aggregateForScope(attempts: AttemptRow[], numbers: Map<string, NumberRow>): UserBlockedRow[] {
  const by = new Map<string, UserBlockedRow>()
  for (const a of attempts) {
    let r = by.get(a.phone)
    if (!r) {
      r = {
        phone: a.phone,
        firstTried: a.created_at,
        lastTried: a.created_at,
        attempts: 0,
        products: [],
        surfaces: [],
        status: mapStatus(numbers.get(a.phone)?.status),
      }
      by.set(a.phone, r)
    }
    r.attempts += 1
    if (a.created_at < r.firstTried) r.firstTried = a.created_at
    if (a.created_at > r.lastTried) r.lastTried = a.created_at
    if (a.product && !r.products.includes(a.product)) r.products.push(a.product)
    if (!r.surfaces.includes(a.surface as BlockSurface)) r.surfaces.push(a.surface as BlockSurface)
  }
  return [...by.values()].sort((x, y) => (x.lastTried < y.lastTried ? 1 : x.lastTried > y.lastTried ? -1 : 0))
}

export type Section = "shops" | "orders"

export type ScopeFilters = { status?: string | null; from?: string | null; to?: string | null }

// Minimal structural type so tests and the real client both fit.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: string) => any }

function validDate(v: string | null | undefined): string | null {
  if (!v) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/** Aggregated rows for one section, scoped from the session user only. */
export async function loadScopedRows(
  db: Db,
  userId: string,
  section: Section,
  filters: ScopeFilters,
  shopIds: string[]
): Promise<UserBlockedRow[]> {
  if (section === "shops" && shopIds.length === 0) return []

  let q = db.from("mtn_blocked_attempts").select("phone, surface, product, created_at")
  if (section === "shops") q = q.in("shop_id", shopIds)
  else q = q.eq("user_id", userId).in("surface", [...DEALER_SURFACES])
  const from = validDate(filters.from)
  const to = validDate(filters.to)
  if (from) q = q.gte("created_at", from)
  if (to) q = q.lte("created_at", to)
  const { data: attempts, error } = await q.order("created_at", { ascending: false }).limit(USER_ATTEMPT_READ_LIMIT)
  if (error) throw new Error("attempts read failed")
  const list = (attempts ?? []) as AttemptRow[]

  const phones = [...new Set(list.map((a) => a.phone))]
  const numbers = new Map<string, NumberRow>()
  for (let i = 0; i < phones.length; i += 300) {
    const { data, error: nErr } = await db
      .from("mtn_blocked_numbers")
      .select("phone, status")
      .in("phone", phones.slice(i, i + 300))
    if (nErr) throw new Error("numbers read failed")
    for (const n of (data ?? []) as Array<{ phone: string; status: string }>) numbers.set(n.phone, { status: n.status })
  }

  const rows = aggregateForScope(list, numbers)
  const st = filters.status
  return st === "waiting" || st === "ready" || st === "expired" ? rows.filter((r) => r.status === st) : rows
}
