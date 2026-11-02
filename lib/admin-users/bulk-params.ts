// POST /api/admin/users/bulk: request validation. Pure (no I/O).
//
//   { action: "set_role",  userIds: [...], params: { role: "user" | "dealer" | "admin" } }
//   { action: "suspend",   userIds: [...], params: { reason: "3..500 chars" } }
//   { action: "unsuspend", userIds: [...], params: { reason?: "<= 500 chars" } }
//   { action: "notify",    userIds: [...] | matching: {<list filters>},
//                          params: { title, message, channels: ("in_app" | "push" | "sms")[] } }
//
// userIds: 1..200 distinct UUIDs (duplicates are dropped). "Every user matching the filters" (`matching`, the
// list's filters, resolved on the server) is accepted only for notify; role and suspension changes always name
// their users explicitly.
import { BROADCAST_LIMITS } from "@/lib/broadcast-limits"
import { isUuid } from "./drawer-params"
import { parseUsersListParams, type UsersListFilters } from "./list-params"

export const BULK_MAX_USERS = 200
export const BULK_ROLES = ["user", "dealer", "admin"] as const
export type BulkRole = (typeof BULK_ROLES)[number]
export const NOTIFY_CHANNELS = ["in_app", "push", "sms"] as const
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number]
export const SUSPEND_REASON_MIN = 3
export const SUSPEND_REASON_MAX = 500
/** Most users one notify-all-matching may reach: the Broadcast page's per-broadcast limit. */
export const NOTIFY_MATCHING_MAX = BROADCAST_LIMITS.recipientsMax

export type BulkTarget = { kind: "ids"; ids: string[] } | { kind: "matching"; filters: UsersListFilters }

export type BulkRequest =
  | { action: "set_role"; target: { kind: "ids"; ids: string[] }; role: BulkRole }
  | { action: "suspend"; target: { kind: "ids"; ids: string[] }; reason: string }
  | { action: "unsuspend"; target: { kind: "ids"; ids: string[] }; reason: string | null }
  | { action: "notify"; target: BulkTarget; title: string; message: string; channels: NotifyChannel[] }

export type BulkParseResult = { ok: true; request: BulkRequest } | { ok: false; errors: string[] }

const FILTER_KEYS = ["q", "role", "suspended", "hasShop", "pricingMode", "from", "to", "tag"] as const

/** The list filters, as an object (the page's UsersListFilters), validated exactly like the list's query string. */
export function parseMatchingFilters(raw: unknown): { ok: true; filters: UsersListFilters } | { ok: false; errors: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["matching must be an object of list filters"] }
  const sp = new URLSearchParams()
  const errors: string[] = []
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === "sort" || k === "dir") continue // ordering does not change who matches
    if (!(FILTER_KEYS as readonly string[]).includes(k)) { errors.push(`matching.${k} is not a filter`); continue }
    if (v === null || v === undefined || v === "") continue
    if (typeof v !== "string" && typeof v !== "boolean") { errors.push(`matching.${k} must be a string or boolean`); continue }
    sp.set(k, String(v))
  }
  if (errors.length) return { ok: false, errors }
  const parsed = parseUsersListParams(sp)
  if (!parsed.ok) return { ok: false, errors: parsed.errors.map((e) => `matching: ${e}`) }
  const { q, role, suspended, hasShop, pricingMode, from, to, tag, sort, dir } = parsed.params
  return { ok: true, filters: { q, role, suspended, hasShop, pricingMode, from, to, tag, sort, dir } }
}

function parseIds(raw: unknown, errors: string[]): string[] {
  if (!Array.isArray(raw) || raw.length === 0) { errors.push("userIds must be a non-empty array"); return [] }
  if (raw.length > BULK_MAX_USERS) { errors.push(`At most ${BULK_MAX_USERS} users per bulk action`); return [] }
  const bad = raw.filter((id) => !isUuid(id))
  if (bad.length) { errors.push(`userIds must be user ids (${bad.length} invalid)`); return [] }
  return [...new Set((raw as string[]).map((id) => id.toLowerCase()))]
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "")

export function parseBulkRequest(body: unknown): BulkParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, errors: ["Body must be a JSON object"] }
  const b = body as { action?: unknown; userIds?: unknown; matching?: unknown; params?: unknown }
  const errors: string[] = []
  const params = (b.params && typeof b.params === "object" && !Array.isArray(b.params) ? b.params : {}) as Record<string, unknown>
  if (b.params !== undefined && params !== b.params) errors.push("params must be an object")

  const action = b.action
  if (action !== "set_role" && action !== "suspend" && action !== "unsuspend" && action !== "notify") {
    return { ok: false, errors: ["action must be one of: set_role, suspend, unsuspend, notify"] }
  }

  let target: BulkTarget | null = null
  if (b.matching !== undefined && b.matching !== null) {
    if (action !== "notify") errors.push("Selecting every matching user is only allowed for notifications; select users explicitly")
    else if (b.userIds !== undefined) errors.push("Send userIds or matching, not both")
    else {
      const m = parseMatchingFilters(b.matching)
      if (m.ok) target = { kind: "matching", filters: m.filters }
      else errors.push(...m.errors)
    }
  } else {
    const ids = parseIds(b.userIds, errors)
    if (ids.length) target = { kind: "ids", ids }
  }

  let request: BulkRequest | null = null
  if (action === "set_role") {
    const role = text(params.role).toLowerCase()
    if (!(BULK_ROLES as readonly string[]).includes(role)) errors.push(`params.role must be one of: ${BULK_ROLES.join(", ")}`)
    else if (target?.kind === "ids") request = { action, target, role: role as BulkRole }
  } else if (action === "suspend" || action === "unsuspend") {
    const reason = text(params.reason)
    if (action === "suspend" && reason.length < SUSPEND_REASON_MIN) errors.push(`params.reason is required (at least ${SUSPEND_REASON_MIN} characters)`)
    else if (reason.length > SUSPEND_REASON_MAX) errors.push(`params.reason must be at most ${SUSPEND_REASON_MAX} characters`)
    else if (target?.kind === "ids") {
      request = action === "suspend" ? { action, target, reason } : { action, target, reason: reason || null }
    }
  } else {
    const title = text(params.title)
    const message = text(params.message)
    if (!title) errors.push("params.title is required")
    else if (title.length > BROADCAST_LIMITS.subjectMax) errors.push(`params.title must be at most ${BROADCAST_LIMITS.subjectMax} characters`)
    if (!message) errors.push("params.message is required")
    else if (message.length > BROADCAST_LIMITS.messageMax) errors.push(`params.message must be at most ${BROADCAST_LIMITS.messageMax} characters`)
    const ch = params.channels
    let channels: NotifyChannel[] = []
    if (!Array.isArray(ch) || ch.length === 0) errors.push(`params.channels must list at least one of: ${NOTIFY_CHANNELS.join(", ")}`)
    else if (ch.some((c) => !(NOTIFY_CHANNELS as readonly unknown[]).includes(c))) errors.push(`params.channels may only contain: ${NOTIFY_CHANNELS.join(", ")}`)
    else channels = NOTIFY_CHANNELS.filter((c) => ch.includes(c))
    if (target && title && message && channels.length && !errors.length) request = { action, target, title, message, channels }
  }

  if (errors.length || !request) return { ok: false, errors: errors.length ? errors : ["Invalid request"] }
  return { ok: true, request }
}

export type BulkAction = BulkRequest["action"]

const ROLE_LABEL: Record<BulkRole, string> = { user: "User", dealer: "Dealer", admin: "Admin" }
const usersWord = (n: number) => `${n.toLocaleString()} user${n === 1 ? "" : "s"}`

/** The confirmation question, with the count: "Suspend 37 users?". */
export function bulkConfirmTitle(action: BulkAction, count: number, role?: BulkRole | null): string {
  switch (action) {
    case "set_role": return `Change ${usersWord(count)} to ${ROLE_LABEL[role ?? "user"]}?`
    case "suspend": return `Suspend ${usersWord(count)}?`
    case "unsuspend": return `Unsuspend ${usersWord(count)}?`
    case "notify": return `Send a notification to ${usersWord(count)}?`
  }
}

export interface BulkResultRow { id: string; ok: boolean; error?: string; note?: string }

/** Counts for the result summary: failures grouped by message (most common first), and how many were unchanged. */
export function summariseBulkResults(results: BulkResultRow[]) {
  const failed = results.filter((r) => !r.ok)
  const byError = new Map<string, string[]>()
  for (const r of failed) {
    const k = r.error || "Failed"
    byError.set(k, [...(byError.get(k) ?? []), r.id])
  }
  return {
    total: results.length,
    succeeded: results.length - failed.length,
    failed: failed.length,
    unchanged: results.filter((r) => r.ok && r.note?.includes("unchanged")).length,
    errors: [...byError.entries()].map(([error, ids]) => ({ error, ids })).sort((a, b) => b.ids.length - a.ids.length),
  }
}
