// lib/ussd-hubtel/interaction-routes.ts
// Request parsing shared by the admin and shop-owner session-transcript endpoints.
import { TS_RE } from "./interaction-log"

export const SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100

/** limit / before from the query string, or an error message. */
export function parseListParams(q: URLSearchParams): { limit: number; before: string | null } | { error: string } {
  let limit = DEFAULT_LIMIT
  const limitRaw = q.get("limit")
  if (limitRaw !== null) {
    if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > MAX_LIMIT) return { error: `limit must be 1-${MAX_LIMIT}` }
    limit = Number(limitRaw)
  }
  const before = q.get("before")
  if (before !== null && !TS_RE.test(before)) return { error: "before must be a timestamp returned as nextBefore" }
  return { limit, before }
}
