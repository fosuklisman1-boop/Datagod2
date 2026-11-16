/**
 * Shared query pieces for the admin list and the full-report export, so the export is "filtered as the table".
 * Service-role client only (called from admin routes after verifyAdminAccess).
 */

import type { ListParams } from "./admin-view"

export const NUMBER_COLUMNS =
  "id, phone, status, first_blocked_at, last_blocked_at, attempts, providers_rejected, recheck_count, last_rechecked_at, " +
  "allowed_at, allowed_by, submitted_to_supplier, submitted_at, customer_notified_at, handled_at, notes, expires_at, last_surface, last_shop_id"

/** The report export also needs who was texted (a row only counts as texted when a notify phone is set). */
export const EXPORT_COLUMNS = NUMBER_COLUMNS + ", customer_notify_phone"

export type NumberRow = {
  id: string
  phone: string
  status: string
  first_blocked_at: string | null
  last_blocked_at: string | null
  attempts: number | null
  providers_rejected: string[] | null
  recheck_count: number | null
  last_rechecked_at: string | null
  allowed_at: string | null
  allowed_by: string | null
  submitted_to_supplier: string | null
  submitted_at: string | null
  customer_notified_at: string | null
  customer_notify_phone?: string | null
  handled_at: string | null
  notes: string | null
  expires_at: string | null
  last_surface: string | null
  last_shop_id: string | null
}

type Db = { from(table: string): any }

/** Shop ids whose name matches the search text (bounded). Null when the text is not a shop-name search. */
export async function shopIdsForSearch(db: Db, q: string | null): Promise<string[] | null> {
  if (!q || /^[\d .\-]+$/.test(q)) return null
  const { data, error } = await db.from("user_shops").select("id").ilike("shop_name", `%${q}%`).limit(50)
  if (error) throw new Error(`shop search failed: ${error.code ?? "db"}`)
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
}

/** Applies the parsed filters. `shopSearchIds` comes from shopIdsForSearch (an empty array matches nothing). */
export function applyFilters(query: any, p: ListParams, shopSearchIds: string[] | null): any {
  let q = query
  if (p.status) q = q.eq("status", p.status)
  if (p.surface) q = q.eq("last_surface", p.surface)
  if (p.shopId) q = q.eq("last_shop_id", p.shopId)
  if (p.from) q = q.gte("last_blocked_at", p.from)
  if (p.to) q = q.lte("last_blocked_at", p.to)
  if (p.q) {
    if (shopSearchIds === null) q = q.ilike("phone", `%${p.q.replace(/[^\d]/g, "")}%`)
    else q = shopSearchIds.length > 0 ? q.in("last_shop_id", shopSearchIds) : q.eq("id", "00000000-0000-0000-0000-000000000000")
  }
  return q
}

export async function shopNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = [...new Set(ids)]
  for (let i = 0; i < unique.length; i += 200) {
    const { data, error } = await db.from("user_shops").select("id, shop_name").in("id", unique.slice(i, i + 200))
    if (error) throw new Error(`shop names failed: ${error.code ?? "db"}`)
    for (const s of (data ?? []) as Array<{ id: string; shop_name: string | null }>) out.set(s.id, s.shop_name ?? "Unnamed shop")
  }
  return out
}
