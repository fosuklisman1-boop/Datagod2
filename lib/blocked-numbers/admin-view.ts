/**
 * Pure helpers for the admin blocked-numbers routes: query parsing, body validation, export rows, aggregation.
 * No DB or network here so every rule is unit-testable. Phones may appear in admin responses; never in logs.
 */

import { normalizeGhanaPhone } from "@/lib/phone-format"
import { BLOCK_SURFACES } from "./types"

export const PAGE_SIZE = 50
export const MAX_RECHECK_IDS = 500
export const MAX_NOTE = 500
export const EXPORT_LIMIT = 10_000
export const NUMBER_STATUSES = ["blocked", "allowed", "expired", "handled"] as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v)
}

export type ListParams = {
  page: number
  status: (typeof NUMBER_STATUSES)[number] | null
  surface: string | null
  shopId: string | null
  q: string | null
  from: string | null
  to: string | null
}

function isoOrNull(v: string | null): string | null {
  if (!v) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/** Unknown / malformed filter values are dropped (never forwarded into a query). */
export function parseListParams(sp: URLSearchParams): ListParams {
  const pageRaw = Number(sp.get("page"))
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? Math.min(pageRaw, 100_000) : 1
  const status = sp.get("status")
  const surface = sp.get("surface")
  const shop = sp.get("shop")
  // Letters, digits, space, dash, dot only: nothing that can alter a PostgREST filter expression or a LIKE pattern.
  const q = (sp.get("q") ?? "").replace(/[^A-Za-z0-9 .\-]/g, "").trim().slice(0, 60)
  return {
    page,
    status: (NUMBER_STATUSES as readonly string[]).includes(status ?? "") ? (status as ListParams["status"]) : null,
    surface: (BLOCK_SURFACES as readonly string[]).includes(surface ?? "") ? surface : null,
    shopId: isUuid(shop) ? shop : null,
    q: q.length > 0 ? q : null,
    from: isoOrNull(sp.get("from")),
    to: isoOrNull(sp.get("to")),
  }
}

export type UpdateBody = { id: string; action: "handle" | "reopen"; note: string | null }
type Valid<T> = ({ ok: true } & T) | { ok: false; error: string }

export function validateUpdateBody(body: unknown): Valid<{ value: UpdateBody }> {
  if (!body || typeof body !== "object") return { ok: false, error: "Body must be an object" }
  const b = body as Record<string, unknown>
  if (!isUuid(b.id)) return { ok: false, error: "id must be a uuid" }
  if (b.action !== "handle" && b.action !== "reopen") return { ok: false, error: "action must be handle or reopen" }
  if (b.action === "handle") {
    const note = typeof b.note === "string" ? b.note.trim() : ""
    if (!note) return { ok: false, error: "A note is required to mark a number handled" }
    if (note.length > MAX_NOTE) return { ok: false, error: `Note must be at most ${MAX_NOTE} characters` }
    return { ok: true, value: { id: b.id, action: "handle", note } }
  }
  return { ok: true, value: { id: b.id, action: "reopen", note: null } }
}

export type RecheckBody = { ids: string[] } | { all: true }

export function validateRecheckBody(body: unknown): Valid<{ value: RecheckBody }> {
  if (!body || typeof body !== "object") return { ok: false, error: "Body must be an object" }
  const b = body as Record<string, unknown>
  if (b.all === true) return { ok: true, value: { all: true } }
  if (!Array.isArray(b.ids) || b.ids.length === 0) return { ok: false, error: "Provide ids or all:true" }
  if (b.ids.length > MAX_RECHECK_IDS) return { ok: false, error: `At most ${MAX_RECHECK_IDS} ids per request` }
  if (!b.ids.every(isUuid)) return { ok: false, error: "ids must be uuids" }
  return { ok: true, value: { ids: [...new Set(b.ids as string[])] } }
}

/** Supplier hand-off sheet: one `Phone` column, local 0XXXXXXXXX, deduped (same shape as the MTN Registration export). */
export function supplierRows(phones: string[]): Array<{ Phone: string }> {
  const seen = new Set<string>()
  const out: Array<{ Phone: string }> = []
  for (const raw of phones) {
    const p = typeof raw === "string" ? normalizeGhanaPhone(raw) : null
    if (!p || seen.has(p)) continue
    seen.add(p)
    out.push({ Phone: p })
  }
  return out
}

export type AttemptLite = { blocked_number_id: string; surface: string; shop_id: string | null }

/** Distinct surfaces and shop ids per blocked number, first-seen order. */
export function aggregateAttempts(rows: AttemptLite[]): Map<string, { surfaces: string[]; shopIds: string[] }> {
  const m = new Map<string, { surfaces: string[]; shopIds: string[] }>()
  for (const r of rows) {
    let e = m.get(r.blocked_number_id)
    if (!e) {
      e = { surfaces: [], shopIds: [] }
      m.set(r.blocked_number_id, e)
    }
    if (!e.surfaces.includes(r.surface)) e.surfaces.push(r.surface)
    if (r.shop_id && !e.shopIds.includes(r.shop_id)) e.shopIds.push(r.shop_id)
  }
  return m
}

export function chunked<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}
