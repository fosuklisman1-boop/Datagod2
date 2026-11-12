// Server-side parsing for GET /api/admin/users/export (keyset-paginated export).
// Kept apart from list-params.ts because the cursor uses Node's Buffer.

import {
  nextDay,
  normaliseDateRange,
  normaliseSearch,
  parseUsersListParams,
  type UsersListFilters,
} from "./list-params"

/** Rows per export request (and the RPC's maximum). */
export const EXPORT_CHUNK_SIZE = 5000

/** Position after the last exported row: (created_at, id) exactly as Postgres printed them. */
export interface ExportCursor {
  createdAt: string
  id: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Postgres' jsonb text for timestamptz, kept as text so microseconds survive the round trip.
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:\d{2})?)$/

/** Opaque, URL-safe cursor string. */
export function encodeExportCursor(c: ExportCursor): string {
  return Buffer.from(JSON.stringify([c.createdAt, c.id]), "utf8").toString("base64url")
}

export function decodeExportCursor(s: string | null | undefined): ExportCursor | null {
  if (!s || !/^[A-Za-z0-9_-]+$/.test(s)) return null
  try {
    const v = JSON.parse(Buffer.from(s, "base64url").toString("utf8"))
    if (!Array.isArray(v) || v.length !== 2) return null
    const [createdAt, id] = v
    if (typeof createdAt !== "string" || typeof id !== "string") return null
    if (!UUID_RE.test(id)) return null
    if (createdAt !== "-infinity" && !TS_RE.test(createdAt)) return null
    return { createdAt, id }
  } catch {
    return null
  }
}

export type ExportParseResult =
  | { ok: true; filters: UsersListFilters; cursor: ExportCursor | null; limit: number }
  | { ok: false; errors: string[] }

/**
 * Filters as for the list (same validation); sort/dir/page/pageSize are ignored because the
 * export order is fixed. A reversed date range is swapped, as on the page.
 */
export function parseExportParams(sp: URLSearchParams): ExportParseResult {
  const listSp = new URLSearchParams(sp)
  for (const k of ["sort", "dir", "page", "pageSize", "cursor", "limit"]) listSp.delete(k)
  const from = listSp.get("from")
  const to = listSp.get("to")
  if (from && to && from > to) {
    listSp.set("from", to)
    listSp.set("to", from)
  }
  const parsed = parseUsersListParams(listSp)
  const errors = parsed.ok ? [] : [...parsed.errors]

  let cursor: ExportCursor | null = null
  const rawCursor = sp.get("cursor")
  if (rawCursor) {
    cursor = decodeExportCursor(rawCursor)
    if (!cursor) errors.push("cursor is invalid")
  }

  let limit = EXPORT_CHUNK_SIZE
  const rawLimit = (sp.get("limit") ?? "").trim()
  if (rawLimit) {
    if (!/^\d{1,9}$/.test(rawLimit)) errors.push(`limit must be an integer from 1 to ${EXPORT_CHUNK_SIZE}`)
    else limit = Math.min(Math.max(Number(rawLimit), 1), EXPORT_CHUNK_SIZE)
  }

  if (errors.length || !parsed.ok) return { ok: false, errors }
  const { q, role, suspended, hasShop, pricingMode, tag, sort, dir } = parsed.params
  const range = normaliseDateRange({ from: parsed.params.from, to: parsed.params.to })
  return { ok: true, filters: { q, role, suspended, hasShop, pricingMode, from: range.from, to: range.to, tag, sort, dir }, cursor, limit }
}

export interface AdminExportUsersArgs {
  p_search: string | null
  p_role: string | null
  p_suspended: boolean | null
  p_has_shop: boolean | null
  p_pricing_mode: string | null
  p_created_from: string | null
  p_created_to: string | null
  p_after_created_at: string | null
  p_after_id: string | null
  p_limit: number
  p_tag: string | null
}

export function toExportRpcArgs(f: UsersListFilters, cursor: ExportCursor | null, limit: number): AdminExportUsersArgs {
  return {
    p_search: normaliseSearch(f.q),
    p_role: f.role,
    p_suspended: f.suspended,
    p_has_shop: f.hasShop,
    p_pricing_mode: f.pricingMode,
    p_created_from: f.from ? `${f.from}T00:00:00Z` : null,
    p_created_to: f.to ? `${nextDay(f.to)}T00:00:00Z` : null,
    p_after_created_at: cursor?.createdAt ?? null,
    p_after_id: cursor?.id ?? null,
    p_limit: Math.min(Math.max(Math.trunc(limit) || EXPORT_CHUNK_SIZE, 1), EXPORT_CHUNK_SIZE),
    p_tag: f.tag ?? null,
  }
}

/** Shape check for admin_export_users' jsonb result. */
export function parseExportRpcResult(data: unknown): { rows: unknown[]; nextCursor: ExportCursor | null } {
  if (!data || typeof data !== "object") throw new Error("admin_export_users returned no data")
  const d = data as { rows?: unknown; next_cursor?: unknown }
  if (!Array.isArray(d.rows)) throw new Error("admin_export_users returned bad rows")
  if (d.next_cursor == null) return { rows: d.rows, nextCursor: null }
  const c = d.next_cursor as { created_at?: unknown; id?: unknown }
  if (typeof c.created_at !== "string" || typeof c.id !== "string") throw new Error("admin_export_users returned a bad cursor")
  return { rows: d.rows, nextCursor: { createdAt: c.created_at, id: c.id } }
}
