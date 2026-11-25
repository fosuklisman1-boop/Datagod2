import { z } from "zod"
import type { CardCtx, CardLine, CatalogEntry, EntryInput } from "../types"
import { pageTitleFor } from "../pages"
import { hasEnded, parseAdminPeriod, periodLabel } from "@/lib/leaderboard/periods"
import { bundleLabel, defaultPrizeLabel, type PrizeFields, type PrizeType } from "@/lib/leaderboard/prizes"
import { LEADERBOARD_CONFIG_KEY } from "@/lib/leaderboard/public"
import { audienceLabel, reasonLabel } from "@/lib/ai-console/review"
import { SERVICES } from "@/lib/api-v2/services"

// Platform group: /api/admin/ api-v2, api-v1, api-keys, api-logs, leaderboard, dashboard-stats, dashboard-analytics,
// security-alerts, scheduled-tasks, ai-conversations. (The last area task; after it PENDING is empty.)
//
// API keys: no lookup here ever returns key material. The v1 and v2 key listings select identity, owner, status, limits and
// dates only (never key, key_hash, key_prefix or the like); the log lookups leave out key prefixes, IP addresses and the raw
// request/response bodies. No route here RETURNS a newly generated key (key requests are made by developers on their own
// pages, approval only activates a key that already exists), so nothing needs excluding for that reason. Cards read key rows
// with an explicit column list that never includes a hash or prefix.
//
// Auth: every route uses verifyAdminAccess (or requireAdmin, a wrapper over it): "admin". The scheduled-tasks routes do their
// own bearer-token check (an admin sees every task, anyone else only their own): "other".
//
// GETs: all lookups here are read-only. The dashboard RPCs (get_admin_dashboard_*), get_leaderboard and the log/stat readers
// only SELECT (checked in the migrations), so they are lookups and need no ruling G-default: no GET here writes anything.
//
// Excluded from this group: POST /api/admin/api-v1/retirement/notify (long-running, sends SMS and email to every v1 key holder).

type Card = { summary: string; lines: CardLine[] }
type Obj = Record<string, unknown>
type Read = { state: "found"; row: Obj } | { state: "missing" } | { state: "unread" }

const mk = (e: Omit<CatalogEntry, "area" | "pageTitle">): CatalogEntry => ({ ...e, area: "platform", pageTitle: pageTitleFor(e.page) ?? e.page })

const HOME = "/admin"
const API_KEYS = "/admin/api-keys"
const LEADERBOARD = "/admin/leaderboard"
const SCHEDULED = "/admin/scheduled-tasks"
const SECURITY = "/admin/security"
const AI = "/admin/ai-assistant"

const uuid = z.string().uuid()
const bool = z.boolean()
const pageNo = z.number().int().min(0).max(100000)
const reason = z.string().trim().min(3).max(200)
const dateTime = z.string().datetime({ offset: true })
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const periodKind = z.enum(["daily", "weekly", "monthly", "yearly"])
const board = z.enum(["dashboard", "shop"])

const asBody = (i: EntryInput): Obj => (i.body ?? {}) as Obj
const asParams = (i: EntryInput): Record<string, string> => i.params ?? {}
const asQuery = (i: EntryInput): Obj => (i.query ?? {}) as Obj
const str = (v: unknown): string => (typeof v === "string" ? v : "")
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const has = (o: Obj, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined
const onOff = (b: boolean): string => (b ? "ON" : "OFF")
const ghs = (v: unknown): string => (Number.isFinite(Number(v)) && v !== null && v !== "" ? `GHS ${Number(v).toFixed(2)}` : "unknown")
const shown = (v: unknown): string => (typeof v === "string" ? (v === "" ? "(empty)" : v) : v === null || v === undefined ? "(not set)" : typeof v === "object" ? JSON.stringify(v) : String(v))
const change = (a: string, b: string): string => `${a} -> ${b}`
const short = (id: string): string => (id ? id.slice(0, 8) : "(no id)")
const fullName = (r: Obj | null | undefined): string => [str(r?.first_name), str(r?.last_name)].filter(Boolean).join(" ")
const list = (xs: unknown[]): string => (xs.length ? xs.map(String).join(", ") : "(none)")

async function readOne(run: () => PromiseLike<{ data: unknown; error?: unknown }>): Promise<Read> {
  try {
    const { data, error } = await run()
    if (error) return { state: "unread" }
    if (!data || typeof data !== "object" || Array.isArray(data)) return { state: "missing" }
    return { state: "found", row: data as Obj }
  } catch {
    return { state: "unread" }
  }
}

async function readRows(run: () => PromiseLike<{ data: unknown; error?: unknown }>): Promise<Obj[] | null> {
  try {
    const { data, error } = await run()
    if (error || !Array.isArray(data)) return null
    return data as Obj[]
  } catch {
    return null
  }
}

async function readCount(run: () => PromiseLike<{ data?: unknown; count?: number | null; error?: unknown }>): Promise<number | null> {
  try {
    const { data, count, error } = await run()
    if (error) return null
    if (typeof count === "number") return count
    return Array.isArray(data) ? data.length : null
  } catch {
    return null
  }
}

const rowBy = (ctx: CardCtx, table: string, cols: string, col: string, val: string): Promise<Read> =>
  readOne(() => ctx.db.from(table).select(cols).eq(col, val).maybeSingle())

const UNREAD: CardLine = { label: "Problem", value: "The current record could not be read just now, so the old values cannot be shown." }
const MISSING: CardLine = { label: "Problem", value: "No such record was found: the request will most likely be refused." }
const noteLine = (r: Read): CardLine[] => (r.state === "unread" ? [UNREAD] : r.state === "missing" ? [MISSING] : [])
const rowOf = (r: Read): Obj | null => (r.state === "found" ? r.row : null)
const problem = (value: string): CardLine => ({ label: "Problem", value })
const effect = (value: string): CardLine => ({ label: "Effect", value })

/** A person by id: name, email, role. Never a phone number. */
async function person(ctx: CardCtx, userId: string): Promise<{ text: string; row: Obj | null; read: Read }> {
  const read = await rowBy(ctx, "users", "id, first_name, last_name, email, role, is_suspended", "id", userId)
  const row = rowOf(read)
  if (!row) return { text: `user id ${userId}`, row: null, read }
  const name = fullName(row) || "(no name)"
  return { text: `${name}${row.email ? `, ${str(row.email)}` : ""} (${str(row.role) || "no role"}, id ${short(userId)})`, row, read }
}

const nameOnly = (p: { row: Obj | null }, fallback: string): string => (p.row ? fullName(p.row) || "(no name)" : fallback)

// ---------------------------------------------------------------------------------------------------------------------
// API v2: approvals, config, grants, keys
// ---------------------------------------------------------------------------------------------------------------------

const DEFAULT_LIMITS: Record<string, number> = { purchase: 10, bulk: 3, balance: 30, status: 30 }
const LIMIT_GROUPS = ["purchase", "bulk", "balance", "status"] as const

/** The developer's current active live key of the same type, which an approved live key replaces. */
async function replacedKeyLine(ctx: CardCtx, key: Obj, keyId: string): Promise<CardLine[]> {
  if (str(key.environment) !== "live") return []
  const rows = await readRows(() =>
    ctx.db.from("api_v2_keys").select("id, name, key_type").eq("user_id", str(key.user_id)).eq("key_type", str(key.key_type)).eq("status", "active").eq("environment", "live").neq("id", keyId),
  )
  if (!rows || rows.length === 0) return []
  return [{ label: "Replaces", value: `the developer's current live ${str(key.key_type)} key "${str(rows[0].name) || "(no name)"}": it keeps working until this key is active, then it is retired` }]
}

async function approveRejectLines(ctx: CardCtx, kind: "key" | "access", action: string, id: string, reasonText: string): Promise<CardLine[]> {
  const access = kind === "access"
  const r = await rowBy(ctx, access ? "api_v2_access_requests" : "api_v2_keys", access ? "id, user_id, request_code, status" : "id, user_id, key_type, environment, status, name, request_code", "id", id)
  const row = rowOf(r)
  const lines: CardLine[] = []
  if (row) {
    const what = access ? `API access request ${str(row.request_code)}` : `${str(row.environment)} ${str(row.key_type)} key "${str(row.name) || "(no name)"}", request ${str(row.request_code)}`
    lines.push({ label: "Request", value: `${what} (status ${str(row.status)}, id ${short(id)})` })
    const p = await person(ctx, str(row.user_id))
    lines.push({ label: "Developer", value: p.text })
    if (action === "approve") {
      if (p.row?.is_suspended === true) lines.push(problem("This account is suspended, so the approval will be refused."))
      if (str(row.status) !== "pending") lines.push(problem(`This request is ${str(row.status)}, not pending, so the decision will be refused.`))
      if (!access) lines.push(...(await replacedKeyLine(ctx, row, id)))
    } else if (str(row.status) !== "pending") lines.push(problem(`This request is ${str(row.status)}, not pending, so the decision will be refused.`))
  } else lines.push({ label: "Request", value: `${access ? "access request" : "key"} id ${id}` }, ...noteLine(r))
  if (action === "approve") {
    lines.push(effect(access
      ? "The developer gets API-only access (they may then ask for keys). They are told by message that it was approved. The decision is recorded in the audit trail."
      : "The key becomes active straight away and the developer can use it. They are told by message that it was approved. The decision is recorded in the audit trail."))
  } else {
    lines.push({ label: "Reason sent to the developer", value: reasonText || "(none given)" })
    if (reasonText.length < 3 || reasonText.length > 200) lines.push(problem("A reason of 3 to 200 characters is needed to reject: without one the request is refused."))
    lines.push(effect(`The request is closed and the developer is told it was rejected, with the reason above. The decision is recorded in the audit trail.`))
  }
  return lines
}

const decideCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const kind = b.kind === "access" ? "access" : "key"
  const action = str(b.action)
  const lines = await approveRejectLines(ctx, kind, action, asParams(i).id ?? "", str(b.reason).trim())
  return { summary: `${action === "approve" ? "Approve" : "Reject"} an API ${kind === "access" ? "access request" : "key request"}`, lines }
}

const keyPatchCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const id = asParams(i).id ?? ""
  const action = str(b.action)
  if (action === "approve" || action === "reject") {
    const lines = await approveRejectLines(ctx, "key", action, id, str(b.reason).trim())
    return { summary: `${action === "approve" ? "Approve" : "Reject"} an API v2 key request`, lines }
  }
  const r = await rowBy(ctx, "api_v2_keys", "id, user_id, key_type, environment, status, name, request_code", "id", id)
  const row = rowOf(r)
  const lines: CardLine[] = []
  if (row) {
    lines.push({ label: "Key", value: `"${str(row.name) || "(no name)"}" (${str(row.environment)} ${str(row.key_type)}, status ${str(row.status)}, id ${short(id)})` })
    lines.push({ label: "Developer", value: (await person(ctx, str(row.user_id))).text })
  } else lines.push({ label: "Key", value: `id ${id}` }, ...noteLine(r))
  const status = row ? str(row.status) : ""
  if (action === "revoke") {
    if (row && status !== "pending" && status !== "active") lines.push(problem(`This key is ${status}, so the revoke will be refused.`))
    lines.push({ label: "Status", value: change(status || "current", "revoked") })
    lines.push(effect("The key stops working immediately for every request. A revoked key cannot be undone or reactivated: the developer must ask for a new one. The developer is not sent a message. The revoke is recorded in the audit trail."))
  } else if (action === "set_limits") {
    const limits = (b.limits ?? null) as Obj | null
    if (status === "revoked") lines.push(problem("This key is revoked, so changing its limits will be refused."))
    if (!limits) lines.push(problem("The new limits are needed: without them the request is refused."))
    else {
      for (const g of LIMIT_GROUPS) {
        lines.push({ label: `Limit: ${g}`, value: has(limits, g) ? `${shown(limits[g])} requests per minute` : `default (${DEFAULT_LIMITS[g]} per minute)` })
      }
    }
    lines.push(effect("These per-minute limits REPLACE any custom limits the key had; any group not listed goes back to its default. Takes effect on the next request. Recorded in the audit trail."))
  } else {
    if (status === "revoked") lines.push(problem("This key is revoked, so changing its limits will be refused."))
    lines.push({ label: "Limits", value: `back to the defaults (${LIMIT_GROUPS.map((g) => `${g} ${DEFAULT_LIMITS[g]}`).join(", ")} requests per minute)` })
    lines.push(effect("Any custom limits on this key are removed. Takes effect on the next request. Recorded in the audit trail."))
  }
  const verb = action === "revoke" ? "Revoke" : action === "set_limits" ? "Change the limits of" : "Reset the limits of"
  return { summary: `${verb} an API v2 key`, lines }
}

const configUpdateCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const r = await readOne(() => ctx.db.from("api_v2_config").select("enabled, allowed_roles").eq("id", true).maybeSingle())
  const cur = rowOf(r)
  const lines: CardLine[] = [...noteLine(r)]
  const any = has(b, "enabled") || has(b, "allowed_roles") || has(b, "approval_whatsapp")
  if (!any) lines.push(problem("Nothing to change: the request is refused (\"Nothing to update\")."))
  if (has(b, "enabled")) {
    const was = cur ? (cur.enabled === true ? "ON" : "OFF") : "current"
    lines.push({ label: "API v2 switch", value: change(was, onOff(b.enabled === true)) })
    lines.push(effect(b.enabled === true ? "Developers can use API v2 again (with their approved keys)." : "While OFF every API v2 request is refused: every developer integration on v2 stops until it is switched back on."))
  }
  if (has(b, "allowed_roles")) {
    const next = Array.from(new Set(arr(b.allowed_roles).map(String)))
    lines.push({ label: "Roles allowed to use API v2", value: change(cur ? list(arr(cur.allowed_roles)) : "current", list(next)) })
    lines.push(effect("Only people with these roles (or a personal grant) can ask for and use keys. A role that is not an active role is refused, unless it is already in the list."))
  }
  if (has(b, "approval_whatsapp")) {
    const v = b.approval_whatsapp
    lines.push({ label: "Approval WhatsApp contact", value: v === null || v === "" ? "cleared: developers are sent to the support number instead" : `${str(v)} (stored as digits; a wa.me link is accepted)` })
  }
  lines.push(effect("The change is saved and recorded in the audit trail (the contact number itself is not recorded). Nobody is sent a message."))
  return { summary: "Change the API v2 settings", lines }
}

const grantRemoveCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const userId = asParams(i).userId ?? ""
  const p = await person(ctx, userId)
  const text = str(asBody(i).reason).trim()
  const lines: CardLine[] = [{ label: "Person", value: p.text }, ...noteLine(p.read)]
  lines.push({ label: "Reason sent to the person", value: text || "(none given)" })
  if (text.length < 3 || text.length > 200) lines.push(problem("A reason of 3 to 200 characters is needed: without one the request is refused."))
  lines.push(effect("Their personal API access grant is removed. Their keys are not revoked, but each one stops working on its next request unless their role is allowed to use the API. They are told by message, with the reason. Recorded in the audit trail."))
  return { summary: "Remove a person's API-only access grant", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// API v2 admin console: announcements, developer pause, service pause
// ---------------------------------------------------------------------------------------------------------------------

const SERVICE_IDS = SERVICES.map((s) => s.id)
const MAX_ANNOUNCEMENTS = 50

const announcementLines = async (i: EntryInput, ctx: CardCtx, id: string | null): Promise<CardLine[]> => {
  const b = asBody(i)
  const title = str(b.title).trim()
  const text = str(b.body).trim()
  const starts = str(b.startsAt)
  const ends = str(b.endsAt)
  const lines: CardLine[] = []
  if (id) {
    const r = await rowBy(ctx, "api_v2_announcements", "id, title, body, severity, starts_at, ends_at", "id", id)
    const cur = rowOf(r)
    if (cur) {
      lines.push({ label: "Editing", value: `"${str(cur.title)}" (${str(cur.severity)}, ${str(cur.starts_at)} to ${str(cur.ends_at)})` })
      if (str(cur.body) !== text) lines.push({ label: "Old text", value: str(cur.body) })
    } else lines.push({ label: "Editing", value: `announcement id ${id}` }, ...noteLine(r))
  } else {
    const n = await readCount(() => ctx.db.from("api_v2_announcements").select("id", { count: "exact", head: true }))
    if (n !== null && n >= MAX_ANNOUNCEMENTS) lines.push(problem(`There are already ${MAX_ANNOUNCEMENTS} announcements, the most allowed: the request will be refused.`))
  }
  lines.push({ label: "Title (shown exactly like this)", value: title })
  lines.push({ label: "Text (shown exactly like this)", value: text })
  lines.push({ label: "Severity", value: str(b.severity) })
  lines.push({ label: "Shown from", value: starts })
  lines.push({ label: "Shown until", value: ends })
  const s = Date.parse(starts)
  const e = Date.parse(ends)
  if (Number.isFinite(s) && Number.isFinite(e) && e <= s) lines.push(problem("The end is not after the start: the request will be refused."))
  if (!title || !text) lines.push(problem("A title and a text are both needed: the request will be refused."))
  lines.push(effect("Developers see this notice on the API pages while it is active (from the start time until the end time). Nobody is sent a message. The change is recorded in the audit trail (title, severity and dates, not the text)."))
  return lines
}

const announcementSaveCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const id = asParams(i).id ?? null
  return { summary: id ? "Edit an API announcement" : "Publish a new API announcement", lines: await announcementLines(i, ctx, id) }
}

const announcementDeleteCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const id = asParams(i).id ?? ""
  const r = await rowBy(ctx, "api_v2_announcements", "id, title, body, severity, starts_at, ends_at", "id", id)
  const cur = rowOf(r)
  const lines: CardLine[] = []
  if (cur) {
    lines.push({ label: "Announcement", value: `"${str(cur.title)}" (${str(cur.severity)}, ${str(cur.starts_at)} to ${str(cur.ends_at)})` })
    lines.push({ label: "Text being removed", value: str(cur.body) })
  } else lines.push({ label: "Announcement", value: `id ${id}` }, ...noteLine(r))
  lines.push(effect("The announcement is deleted for good and disappears from the API pages at once. It cannot be restored. Recorded in the audit trail."))
  return { summary: "Delete an API announcement", lines }
}

const developerPauseCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const userId = asParams(i).userId ?? ""
  const b = asBody(i)
  const pausing = b.paused === true
  const reasonText = str(b.reason).trim()
  const p = await person(ctx, userId)
  const cur = await rowBy(ctx, "api_v2_developer_pauses", "user_id, reason", "user_id", userId)
  const lines: CardLine[] = [{ label: "Developer", value: p.text }, ...noteLine(p.read)]
  const row = rowOf(cur)
  lines.push({ label: "Now", value: row ? `paused (reason: ${str(row.reason) || "none recorded"})` : cur.state === "unread" ? "unknown (could not be read)" : "not paused" })
  if (pausing) {
    lines.push({ label: "Reason (stored in the audit trail)", value: reasonText || "(none given)" })
    const n = Array.from(reasonText).length
    if (n < 3 || n > 200) lines.push(problem("A reason of 3 to 200 characters of plain text is needed: without one the request is refused."))
    if (row) lines.push(problem("This developer is already paused: nothing will change."))
    lines.push(effect("Every API v2 request made with this developer's keys is refused (within about 10 seconds) until they are resumed. Their keys stay approved and nothing is revoked. The developer is not sent a message. Recorded in the audit trail."))
  } else {
    if (cur.state === "missing") lines.push(problem("This developer is not paused: nothing will change."))
    lines.push(effect("The pause is lifted and their keys work again (within about 10 seconds). The developer is not sent a message. Recorded in the audit trail."))
  }
  return { summary: pausing ? "Pause a developer's API access" : "Resume a developer's API access", lines }
}

const servicePauseCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const service = asParams(i).service ?? ""
  const b = asBody(i)
  const pausing = b.paused === true
  const msg = str(b.message).trim()
  const meta = SERVICES.find((s) => s.id === service)
  const cur = await rowBy(ctx, "api_v2_service_controls", "service, paused, message", "service", service)
  const row = rowOf(cur)
  const lines: CardLine[] = [{ label: "Service", value: meta ? `${meta.title} (${meta.id})` : service }]
  if (!meta) lines.push(problem(`No such API service. The services are: ${SERVICE_IDS.join(", ")}. The request will be refused.`))
  lines.push({ label: "Now", value: row ? (row.paused === true ? `paused${str(row.message) ? ` (message: ${str(row.message)})` : ""}` : "running") : cur.state === "unread" ? "unknown (could not be read)" : "no control row yet" })
  if (pausing) {
    lines.push({ label: "Message shown to developers", value: msg || "(none)" })
    if (Array.from(msg).length > 200) lines.push(problem("The message is over 200 characters: the request will be refused."))
    lines.push(effect("New requests for this service are refused for EVERY developer (within about 10 seconds); looking up existing orders stays available. Nobody is sent a message. Recorded in the audit trail."))
  } else {
    if (msg) lines.push({ label: "Message", value: "ignored: resuming clears any message" })
    lines.push(effect("The service accepts requests again for every developer (within about 10 seconds) and its message is cleared. Recorded in the audit trail."))
  }
  return { summary: pausing ? "Pause an API service for all developers" : "Resume an API service for all developers", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// API v1: retirement
// ---------------------------------------------------------------------------------------------------------------------

const retirementCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const r = await readOne(() => ctx.db.from("api_v2_config").select("v1_sunset_at, v1_exempt_user_ids, updated_at").eq("id", true).maybeSingle())
  const cur = rowOf(r)
  const lines: CardLine[] = [...noteLine(r)]
  const next = b.sunset_at === null || b.sunset_at === undefined ? null : str(b.sunset_at)
  lines.push({ label: "Retirement date (v1)", value: change(cur ? shown(cur.v1_sunset_at) : "current", next === null ? "(none: v1 stays on)" : next) })
  if (next) {
    const t = Date.parse(next)
    if (Number.isFinite(t) && t <= Date.now()) lines.push(problem("This date has already passed: API v1 stops working immediately for everyone who is not exempt."))
  } else lines.push({ label: "Meaning", value: "No retirement date: API v1 keeps working for everyone." })
  const newIds = Array.from(new Set(arr(b.exempt_user_ids).map((x) => str(x).toLowerCase()).filter(Boolean)))
  const oldIds = cur ? arr(cur.v1_exempt_user_ids).map((x) => str(x).toLowerCase()) : []
  const nameFor = async (ids: string[]): Promise<string> => {
    if (ids.length === 0) return "(none)"
    const rows = await readRows(() => ctx.db.from("users").select("id, first_name, last_name, email").in("id", ids))
    const byId = new Map((rows ?? []).map((u) => [str(u.id).toLowerCase(), u]))
    return ids.map((id) => { const u = byId.get(id); return u ? `${fullName(u) || "(no name)"}${u.email ? ` <${str(u.email)}>` : ""} (id ${short(id)})` : `id ${id}` }).join("; ")
  }
  lines.push({ label: "Exempt users (the FULL new list)", value: await nameFor(newIds) })
  if (cur) {
    const removed = oldIds.filter((x) => !newIds.includes(x))
    const added = newIds.filter((x) => !oldIds.includes(x))
    lines.push({ label: "Removed from the exempt list", value: await nameFor(removed) })
    lines.push({ label: "Added to the exempt list", value: await nameFor(added) })
    const expected = Date.parse(str(b.expected_updated_at))
    const stored = Date.parse(str(cur.updated_at))
    if (Number.isFinite(expected) && Number.isFinite(stored) && expected !== stored) lines.push(problem("These settings changed since the form was loaded: the request will be refused as stale. Reload the settings and try again."))
  }
  lines.push(effect("After the date, API v1 requests are refused for every user who is not exempt. This REPLACES both the date and the whole exempt list. No message is sent (the retirement notice is sent separately, from the page). An exempt user that does not exist is refused."))
  return { summary: "Change the API v1 retirement date and exempt users", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// API v1 keys + the global kill switch
// ---------------------------------------------------------------------------------------------------------------------

const V1_COLS = "id, user_id, name, is_active, rate_limit_per_min" // never key_hash / key_prefix

async function v1KeyLines(ctx: CardCtx, id: string): Promise<{ lines: CardLine[]; row: Obj | null }> {
  const r = await rowBy(ctx, "user_api_keys", V1_COLS, "id", id)
  const row = rowOf(r)
  if (!row) return { lines: [{ label: "Key", value: `id ${id}` }, ...noteLine(r)], row: null }
  const p = await person(ctx, str(row.user_id))
  return { lines: [{ label: "Key", value: `"${str(row.name) || "(no name)"}" (v1, ${row.is_active === true ? "active" : "disabled"}, ${shown(row.rate_limit_per_min ?? 60)} requests per minute, id ${short(id)})` }, { label: "Owner", value: p.text }], row }
}

const v1UpdateCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const { lines, row } = await v1KeyLines(ctx, str(asQuery(i).id))
  if (typeof b.is_active === "boolean") {
    lines.push({ label: "Status", value: change(row ? (row.is_active === true ? "active" : "disabled") : "current", b.is_active ? "active" : "disabled") })
    lines.push(effect(b.is_active ? "The key works again straight away." : "The key stops working at once. The developer is not told."))
  }
  if (has(b, "rate_limit_per_min")) lines.push({ label: "Requests per minute", value: change(row ? shown(row.rate_limit_per_min ?? 60) : "current", shown(b.rate_limit_per_min)) })
  if (typeof b.is_active !== "boolean" && !has(b, "rate_limit_per_min")) lines.push(problem("Nothing to change: only the last-changed time would be updated."))
  return { summary: "Change an API v1 key", lines }
}

const v1DeleteCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const { lines } = await v1KeyLines(ctx, str(asQuery(i).id))
  lines.push(effect("The key is permanently deleted. It cannot be restored or switched back on; the developer's integration using it stops at once and they are not told. A new key would have to be made by the developer."))
  return { summary: "Permanently delete an API v1 key", lines }
}

const globalKillCard = async (_i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const v1 = await readCount(() => ctx.db.from("user_api_keys").select("id", { count: "exact", head: true }).neq("is_active", false))
  const v2 = await readCount(() => ctx.db.from("api_v2_keys").select("id", { count: "exact", head: true }).in("status", ["pending", "active"]))
  const cfg = await readOne(() => ctx.db.from("api_v2_config").select("enabled").eq("id", true).maybeSingle())
  const c = rowOf(cfg)
  const n = (x: number | null): string => (x === null ? "could not be counted just now" : String(x))
  const lines: CardLine[] = [
    { label: "v1 keys to disable", value: `${n(v1)} (every active v1 key, for every user)` },
    { label: "v2 keys to revoke", value: `${n(v2)} (every pending or active v2 key, for every user; a revoked key cannot be reactivated)` },
    { label: "v2 API switch", value: change(c ? (c.enabled === true ? "ON" : "OFF") : "current", "OFF") },
    effect("EVERY dealer and developer integration on the API stops at once. Nobody is sent a message. v1 keys can be switched back on one at a time from the API Keys page; v2 keys must be requested and approved again; the v2 switch is turned back on from the API v2 settings. If one of the three steps fails the others still apply and the result says which. The action is recorded in the audit trail."),
  ]
  return { summary: "Emergency stop: switch off ALL API keys (v1 and v2) and the v2 API", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// Leaderboard (Top Performers)
// ---------------------------------------------------------------------------------------------------------------------

type Period = NonNullable<ReturnType<typeof parseAdminPeriod>>

const periodOf = (b: Obj): { p: Period; label: string } | null => {
  const p = parseAdminPeriod(b.kind, b.anchor, new Date())
  return p ? { p, label: periodLabel(p.kind, p.range) } : null
}

const periodLine = (x: { p: Period; label: string }): CardLine => ({ label: "Period", value: `${x.p.kind} ${x.label} (${x.p.range.start} to ${x.p.range.end})` })
const BAD_PERIOD = problem("That period is not valid (or too far ahead): the request will be refused.")

const periodRow = (ctx: CardCtx, p: Period): Promise<Read> =>
  readOne(() => ctx.db.from("leaderboard_periods").select("id, kind, starts_on, ends_on, rewards_enabled, status").eq("kind", p.kind).eq("starts_on", p.range.start).maybeSingle())

/** A prize in plain words, with the bundle name looked up for data bundles. */
async function describePrize(ctx: CardCtx, raw: Obj): Promise<{ label: string; detail: string }> {
  const type = str(raw.prize_type) as PrizeType
  let bundle: string | null = null
  if (type === "data_bundle" && str(raw.package_id)) {
    const r = await rowBy(ctx, "packages", "id, network, size", "id", str(raw.package_id))
    const row = rowOf(r)
    bundle = row ? bundleLabel(str(row.network), str(row.size)) : null
  }
  const fields: Omit<PrizeFields, "label"> = {
    prize_type: type, amount: raw.amount === undefined || raw.amount === null ? null : Number(raw.amount), package_id: str(raw.package_id) || null,
    network: str(raw.network) || null, role: null, duration_days: raw.duration_days === undefined || raw.duration_days === null ? null : Number(raw.duration_days),
  }
  const typed = str(raw.label).trim().replace(/\s+/g, " ")
  const label = typed || defaultPrizeLabel(fields, bundle)
  const detail =
    type === "wallet_topup" ? `${ghs(raw.amount)} cash added to the winner's wallet`
    : type === "airtime" ? `${ghs(raw.amount)} ${str(raw.network)} airtime sent to the winner`
    : type === "data_bundle" ? `data bundle ${bundle ?? `(package ${str(raw.package_id) || "not chosen"})`}`
    : type === "role_upgrade" ? `${shown(raw.duration_days)} days of dealer pricing for the winner`
    : "a manual prize, handed over by you"
  return { label, detail }
}

const prizeLines = async (ctx: CardCtx, raw: Obj, label = "New prize"): Promise<CardLine[]> => {
  const d = await describePrize(ctx, raw)
  return [{ label, value: `${d.label}: ${d.detail}` }]
}

const prizeSetCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const x = periodOf(b)
  const lines: CardLine[] = []
  if (!x) lines.push(BAD_PERIOD)
  else {
    lines.push(periodLine(x))
    const pr = await periodRow(ctx, x.p)
    const row = rowOf(pr)
    if (pr.state === "unread") lines.push(UNREAD)
    if (row && str(row.status) !== "open") lines.push(problem("This period is closed, so its prizes can no longer change: the request is refused."))
    if (row) {
      const cur = await readRows(() => ctx.db.from("leaderboard_prizes").select("id, label, prize_type, amount").eq("period_id", str(row.id)).eq("board", str(b.board)).eq("rank", Number(b.rank)).eq("status", "active"))
      lines.push({ label: "Current prize for this rank", value: cur === null ? "could not be read just now" : cur.length ? `${str(cur[0].label)} (${str(cur[0].prize_type)}${cur[0].amount !== null && cur[0].amount !== undefined ? `, ${ghs(cur[0].amount)}` : ""})` : "no active prize" })
    } else if (pr.state === "missing") lines.push({ label: "Current prize for this rank", value: "no active prize (this period has no record yet: it is created on first use)" })
  }
  lines.push({ label: "Board and rank", value: `${str(b.board)} board, rank ${shown(b.rank)}` })
  lines.push(...(await prizeLines(ctx, (b.prize ?? {}) as Obj)))
  lines.push(effect("Replaces the active prize for that rank. This moves no money now: the prize is paid only when the winner's prize is delivered after the period is closed. A data bundle that no longer exists is refused."))
  return { summary: "Set the prize for one rank of a leaderboard period", lines }
}

const prizeCancelCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const id = asParams(i).id ?? ""
  const r = await rowBy(ctx, "leaderboard_prizes", "id, period_id, board, rank, prize_type, label, amount, status", "id", id)
  const row = rowOf(r)
  const lines: CardLine[] = []
  if (row) {
    lines.push({ label: "Prize", value: `${str(row.label)} (${str(row.prize_type)}${row.amount !== null && row.amount !== undefined ? `, ${ghs(row.amount)}` : ""}, ${str(row.board)} board, rank ${shown(row.rank)}, ${str(row.status)}, id ${short(id)})` })
    if (str(row.status) === "cancelled") lines.push(problem("This prize is already cancelled: the request is refused."))
  } else lines.push({ label: "Prize", value: `id ${id}` }, ...noteLine(r))
  lines.push(effect("The prize is cancelled. It stays listed as cancelled and can never be reassigned. Refused if it has already been delivered or is being delivered. Nothing is paid and nobody is told."))
  return { summary: "Cancel a leaderboard prize", lines }
}

const periodRewardsCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const x = periodOf(b)
  const lines: CardLine[] = []
  if (!x) lines.push(BAD_PERIOD)
  else {
    lines.push(periodLine(x))
    const pr = await periodRow(ctx, x.p)
    const row = rowOf(pr)
    if (pr.state === "unread") lines.push(UNREAD)
    if (row && str(row.status) !== "open") lines.push(problem("This period is closed, so its prizes can no longer change: the request is refused."))
    lines.push({ label: "Prizes for this period", value: change(row ? onOff(row.rewards_enabled === true) : "ON (no record yet)", onOff(b.rewards_enabled === true)) })
  }
  lines.push(effect("A period record is created if there is none. With prizes OFF the period can only be closed with no reward. Nothing is paid and nobody is told."))
  return { summary: "Turn prizes on or off for one open leaderboard period", lines }
}

const pauseCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const r = await readOne(() => ctx.db.from("admin_settings").select("value").eq("key", LEADERBOARD_CONFIG_KEY).maybeSingle())
  const cur = rowOf(r)
  const was = cur ? ((cur.value as Obj | null)?.paused === true ? "paused" : "running") : "running (nothing saved yet)"
  const lines: CardLine[] = [
    { label: "Top Performers program", value: change(was, b.paused === true ? "paused" : "running") },
    effect(b.paused === true ? "Every user sees a maintenance notice instead of the rankings. Closing periods and delivering prizes are not blocked. Nobody is sent a message." : "The rankings show to every user again. Nobody is sent a message."),
  ]
  return { summary: b.paused === true ? "Pause the Top Performers program for every user" : "Resume the Top Performers program for every user", lines }
}

const closeCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const rewards = b.with_rewards === true
  const x = periodOf(b)
  const lines: CardLine[] = []
  if (!x) lines.push(BAD_PERIOD)
  else {
    lines.push(periodLine(x))
    if (!hasEnded(x.p.range, new Date())) lines.push(problem("This period has not ended yet: the request is refused."))
    const pr = await periodRow(ctx, x.p)
    const row = rowOf(pr)
    if (pr.state === "unread") lines.push(UNREAD)
    if (row && str(row.status) !== "open") lines.push(problem("This period is already closed: the request is refused."))
    if (rewards) {
      if (!row) {
        if (pr.state === "missing") lines.push(problem("No prizes are set for this period: closing with prizes is refused."))
      } else {
        if (row.rewards_enabled === false) lines.push(problem("Prizes are switched off for this period: closing with prizes is refused."))
        const n = await readCount(() => ctx.db.from("leaderboard_prizes").select("id", { count: "exact", head: true }).eq("period_id", str(row.id)).eq("status", "active"))
        if (n !== null && n < 6) lines.push(problem(`Only ${n} of the 6 prizes (top 3 on each board) are set: closing with prizes is refused.`))
      }
    }
  }
  lines.push({ label: "Prizes", value: rewards ? "Closes WITH prizes: ranks 1 to 3 on each board get their prize." : "Closes with no prizes: results are frozen, nothing is awarded." })
  lines.push(effect("First refreshes every day's totals for the period. Then freezes the top 30 on each board as the final results" + (rewards ? ", gives ranks 1 to 3 their prize" : "") + `, tells the podium winners by notification and locks the prizes. This cannot be reopened or undone.${rewards ? " No money is paid by this step: each prize is paid afterwards with Deliver." : ""}`))
  return { summary: "Close a leaderboard period and freeze the results", lines }
}

type ResultInfo = { result: Obj | null; prize: Obj | null; winner: { text: string; row: Obj | null }; lines: CardLine[] }

async function resultInfo(ctx: CardCtx, resultId: string): Promise<ResultInfo> {
  const r = await readOne(() => ctx.db.from("leaderboard_results").select("id, user_id, board, rank, display_name, prize:leaderboard_prizes(id, label, prize_type, amount, network, duration_days, status)").eq("id", resultId).maybeSingle())
  const result = rowOf(r)
  if (!result) return { result: null, prize: null, winner: { text: "", row: null }, lines: [{ label: "Winner", value: `result id ${resultId}` }, ...noteLine(r)] }
  const p = Array.isArray(result.prize) ? (result.prize[0] as Obj | undefined) ?? null : ((result.prize as Obj | null) ?? null)
  const w = await person(ctx, str(result.user_id))
  return { result, prize: p, winner: w, lines: [{ label: "Winner", value: `${w.text}, ${str(result.board)} board, rank ${shown(result.rank)}` }] }
}

const deliverCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const resultId = str(b.result_id)
  const info = await resultInfo(ctx, resultId)
  const lines = [...info.lines]
  if (info.result) {
    const prize = info.prize
    if (!prize) lines.push(problem("This winner has no prize to deliver: the request is refused."))
    else {
      const type = str(prize.prize_type)
      lines.push({ label: "Prize", value: `${str(prize.label)} (${type}${prize.amount !== null && prize.amount !== undefined ? `, ${ghs(prize.amount)}` : ""})` })
      if (str(prize.status) === "cancelled") lines.push(problem("This prize was cancelled: the request is refused."))
      const dl = await rowBy(ctx, "leaderboard_deliveries", "result_id, status", "result_id", resultId)
      const d = rowOf(dl)
      if (d) {
        const s = str(d.status)
        if (s === "delivered") lines.push(problem("This prize has already been delivered: the request is refused."))
        else if (s === "in_progress") lines.push(problem("This prize is being delivered right now: the request is refused until it finishes."))
        else if (s === "sent") lines.push({ label: "Earlier send", value: "An earlier send is still waiting for its order to finish." })
        else if (s === "failed") lines.push({ label: "Earlier send", value: "The last attempt failed; this retries it." })
      }
      const phone = str(b.phone).trim()
      const who = nameOnly(info.winner, "the winner")
      if (type === "wallet_topup") lines.push(effect(`Adds ${ghs(prize.amount)} to ${who}'s wallet (reference LB-${resultId}; it can never pay twice) and tells them by notification.`))
      else if (type === "role_upgrade") lines.push(effect(`Gives ${who} ${shown(prize.duration_days)} days of dealer pricing (refused for a permanent dealer, sub-agent or admin) and tells them by notification.`))
      else if (type === "data_bundle") {
        lines.push({ label: "Sent to number", value: phone || "the winner's number on file" })
        lines.push(effect(`Creates a GHS 0.00 data order for ${str(prize.label)} and sends it to the supplier now (it is delivered to the number above); tells ${who} by notification once sent. A retry reuses the same order.`))
      } else if (type === "airtime") {
        lines.push({ label: "Sent to number", value: phone || "the winner's number on file" })
        lines.push(effect(`Creates a GHS 0.00 airtime order for ${ghs(prize.amount)} ${str(prize.network)} airtime and sends it through the airtime provider now; tells ${who} by notification once sent.`))
      } else lines.push(problem("A manual prize is never sent from here: the request is refused. Hand it over, then use Mark delivered."))
    }
  }
  return { summary: "Send one winner their leaderboard prize", lines }
}

const markCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const info = await resultInfo(ctx, str(b.result_id))
  const lines = [...info.lines]
  if (info.prize) lines.push({ label: "Prize", value: str(info.prize.label) })
  lines.push({ label: "Note", value: str(b.note).trim().slice(0, 500) || "(none)" })
  lines.push(effect("Records the prize as delivered by hand. Nothing is sent and no money moves; the winner is not told."))
  return { summary: "Record a leaderboard prize as delivered by hand", lines }
}

const presetCreateCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const lines: CardLine[] = [{ label: "Preset name", value: str(b.name).trim() }, ...(await prizeLines(ctx, (b.prize ?? {}) as Obj, "Prize"))]
  lines.push(effect("Saves a reusable prize template for the admin page. No prize is set and nothing is paid."))
  return { summary: "Save a reusable leaderboard prize preset", lines }
}

const presetDeleteCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const id = asParams(i).id ?? ""
  const r = await rowBy(ctx, "leaderboard_prize_presets", "id, name, prize_type, label, amount", "id", id)
  const row = rowOf(r)
  const lines: CardLine[] = [row ? { label: "Preset", value: `"${str(row.name)}" (${str(row.label)}, id ${short(id)})` } : { label: "Preset", value: `id ${id}` }, ...noteLine(r)]
  lines.push(effect("The preset is deleted. Prizes already set from it are not affected (they keep their own copy)."))
  return { summary: "Delete a leaderboard prize preset", lines }
}

const exclusionAddCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const email = str(b.email).trim().toLowerCase()
  const pattern = email.replace(/[\\%_]/g, (c) => `\\${c}`)
  const r = await readOne(() => ctx.db.from("users").select("id, first_name, last_name, email").ilike("email", pattern).maybeSingle())
  const user = rowOf(r)
  const lines: CardLine[] = []
  if (user) {
    lines.push({ label: "Account", value: `${fullName(user) || "(no name)"}, ${str(user.email)}, id ${str(user.id)}` })
    const ex = await rowBy(ctx, "leaderboard_exclusions", "user_id, reason", "user_id", str(user.id))
    const exRow = rowOf(ex)
    if (exRow) lines.push({ label: "Already hidden", value: `yes (reason: ${shown(exRow.reason)}); the reason is replaced` })
  } else if (r.state === "unread") lines.push({ label: "Account", value: `email ${email}` }, UNREAD)
  else lines.push({ label: "Account", value: `email ${email}` }, problem("No user has that email: the request is refused."))
  lines.push({ label: "Reason", value: str(b.reason).trim().slice(0, 200) || "(none)" })
  lines.push(effect("This person is hidden from every leaderboard (daily, weekly, monthly, yearly), now and in later periods, so they cannot rank or win prizes. Nobody is told. Recorded in the audit trail."))
  return { summary: "Hide a user from every leaderboard", lines }
}

const exclusionRemoveCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const userId = str(asQuery(i).userId)
  const p = await person(ctx, userId)
  const ex = await rowBy(ctx, "leaderboard_exclusions", "user_id, reason", "user_id", userId)
  const exRow = rowOf(ex)
  const lines: CardLine[] = [{ label: "Account", value: p.text }, ...noteLine(p.read)]
  if (exRow) lines.push({ label: "Hidden for", value: shown(exRow.reason) })
  else if (ex.state === "missing") lines.push(problem("This user is not hidden: the request is refused."))
  lines.push(effect("The person is shown on the leaderboards again and can rank and win prizes. Nobody is told. Recorded in the audit trail."))
  return { summary: "Put a hidden user back on the leaderboards", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// Scheduled tasks
// ---------------------------------------------------------------------------------------------------------------------

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

function describeSchedule(t: Obj): string {
  const type = str(t.schedule_type)
  if (type === "hourly") return "every hour, on the hour (UTC)"
  if (type === "once") return `once, at ${str(t.run_at_timestamp) || "(no time given)"}`
  const time = str(t.run_at_time)
  if (type === "daily") return `every day at ${time || "(no time given)"} UTC`
  if (type === "weekly") return `every ${arr(t.run_on_days).map((d) => DAYS[Number(d)] ?? String(d)).join(", ") || "(no days given)"} at ${time || "(no time given)"} UTC`
  return type || "(unknown schedule)"
}

const taskCols = "id, name, prompt, context, user_id, schedule_type, run_at_time, run_on_days, run_at_timestamp, notify_channels, is_active, standing_order"

const taskCreateCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const me = await person(ctx, ctx.adminId)
  const lines: CardLine[] = [
    { label: "Task name", value: str(b.name) },
    { label: "What it does (the FULL prompt)", value: str(b.prompt) },
    { label: "When it runs", value: describeSchedule(b) },
    { label: "Runs as", value: `${nameOnly(me, "you")} (you), in the ${str(b.context) || "admin"} assistant` },
    { label: "Reports to", value: `the task owner by ${list(arr(b.notify_channels).length ? arr(b.notify_channels) : ["push"])}` },
  ]
  const type = str(b.schedule_type)
  if ((type === "daily" || type === "weekly") && !str(b.run_at_time)) lines.push(problem("A time of day (run_at_time, HH:MM UTC) is needed for daily and weekly tasks: the request is refused."))
  if (type === "weekly" && arr(b.run_on_days).length === 0) lines.push(problem("The days to run on (run_on_days) are needed for weekly tasks: the request is refused."))
  if (type === "once" && !str(b.run_at_timestamp)) lines.push(problem("The date and time (run_at_timestamp) are needed for a one-off task: the request is refused."))
  lines.push(effect("A new scheduled task is saved and starts running on its own at the times above, without anyone present to approve each run. Times are UTC. Check that the prompt is something you want to run unattended. While the admin catalog switch is ON, an unattended run can only read data and prepare confirm cards that wait for your tap; with the switch OFF, an unattended run can still act directly (change order statuses, retry or fulfil orders, switch settings, send notifications) with no one tapping to approve. It can be paused or deleted from the Scheduled Tasks page."))
  return { summary: "Create a scheduled AI task", lines }
}

async function taskLines(ctx: CardCtx, id: string): Promise<{ lines: CardLine[]; row: Obj | null }> {
  const r = await rowBy(ctx, "ai_scheduled_tasks", taskCols, "id", id)
  const row = rowOf(r)
  if (!row) return { lines: [{ label: "Task", value: `id ${id}` }, ...noteLine(r)], row: null }
  const lines: CardLine[] = [
    { label: "Task", value: `"${str(row.name)}" (${row.is_active === true ? "active" : "paused"}, id ${short(id)})${row.standing_order != null ? ", a standing order" : ""}` },
    { label: "What it does now", value: str(row.prompt) },
    { label: "When it runs", value: describeSchedule(row) },
  ]
  return { lines, row }
}

const taskUpdateCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const { lines, row } = await taskLines(ctx, asParams(i).id ?? "")
  const standing = row?.standing_order != null
  if (typeof b.is_active === "boolean") {
    lines.push({ label: "Status", value: change(row ? (row.is_active === true ? "active" : "paused") : "current", b.is_active ? "active" : "paused") })
    lines.push(effect(b.is_active
      ? (standing ? "It runs again from its next scheduled slot: the next run moves to the next future time and its skip count resets." : "It runs again. Its stored next run time is not recalculated, so a time that has already passed may make it run at the next check.")
      : "It stops running until it is resumed. Nothing already done is undone."))
  }
  if (has(b, "name")) lines.push({ label: "Name", value: change(row ? str(row.name) : "current", str(b.name)) })
  if (has(b, "prompt")) {
    lines.push({ label: "New prompt (FULL)", value: str(b.prompt) })
    lines.push(effect("From the next run the task does this instead, unattended."))
  }
  if (standing && (has(b, "name") || has(b, "prompt"))) lines.push(problem("This is a standing order: its name and prompt cannot be edited, so the request is refused. Pause or delete it and confirm a new card instead."))
  return { summary: "Change a scheduled AI task", lines }
}

const taskDeleteCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const { lines, row } = await taskLines(ctx, asParams(i).id ?? "")
  lines.push(effect(`The task is permanently deleted and will never run again; this cannot be undone.${row?.standing_order != null ? " It is a standing order: the recurring purchase the user approved is cancelled." : ""}`))
  return { summary: "Delete a scheduled AI task", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// Security alerts, AI conversations
// ---------------------------------------------------------------------------------------------------------------------

const alertCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  if (b.action === "acknowledge_all") {
    const rows = await readRows(() => ctx.db.from("security_alerts").select("severity").is("acknowledged_at", null))
    const lines: CardLine[] = []
    if (rows === null) lines.push({ label: "Alerts", value: "could not be counted just now" })
    else {
      const by = (s: string) => rows.filter((r) => str(r.severity) === s).length
      lines.push({ label: "Alerts to mark handled", value: `${rows.length} not yet handled (${by("critical")} critical, ${by("high")} high, ${by("info")} info)` })
    }
    lines.push(effect("EVERY alert not yet handled is marked as handled by you now, including critical ones; they are no longer shown as new. Nothing else changes: no one is blocked or unblocked."))
    return { summary: "Mark all security alerts as handled", lines }
  }
  const id = str(b.id)
  const r = await rowBy(ctx, "security_alerts", "id, severity, category, title, created_at, acknowledged_at", "id", id)
  const row = rowOf(r)
  const lines: CardLine[] = []
  if (row) {
    lines.push({ label: "Alert", value: `${str(row.title)} (${str(row.severity)}, ${str(row.category)}, ${str(row.created_at)}, id ${short(id)})` })
    if (row.acknowledged_at) lines.push({ label: "Already handled", value: `since ${str(row.acknowledged_at)}; the time is overwritten` })
  } else lines.push({ label: "Alert", value: id ? `id ${id}` : "(no id given)" }, ...(id ? noteLine(r) : []))
  if (!id) lines.push(problem("An alert id is needed to mark one alert: the request is refused."))
  lines.push(effect("The alert is marked as handled by you now and no longer shown as new. Nothing else changes: no one is blocked or unblocked."))
  return { summary: "Mark a security alert as handled", lines }
}

const reviewCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const id = asParams(i).id ?? ""
  const r = await rowBy(ctx, "ai_conversations", "id, context, user_id, shop_id, flagged, flag_reasons, reviewed_at, message_count", "id", id)
  const row = rowOf(r)
  const lines: CardLine[] = []
  if (row) {
    const aud = audienceLabel(str(row.context), str(row.user_id) || null, str(row.shop_id) || null)
    lines.push({ label: "Conversation", value: `${aud} chat in ${str(row.context)}, ${shown(row.message_count)} messages (id ${short(id)})` })
    lines.push({ label: "Flagged", value: row.flagged === true ? `flagged: ${list(arr(row.flag_reasons).map((x) => reasonLabel(str(x))))}` : "not flagged" })
    if (row.reviewed_at) lines.push({ label: "Already reviewed", value: `since ${str(row.reviewed_at)}: nothing changes, the original reviewer and time are kept` })
  } else lines.push({ label: "Conversation", value: `id ${id}` }, ...noteLine(r))
  lines.push(effect("Marks the conversation as reviewed by you now. Nothing else changes; the transcript is kept."))
  return { summary: "Mark an assistant conversation as reviewed", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------------------------------------------------

const keyType = z.enum(["standard", "commission", "sms"])
const prizeObject = z.object({
  prize_type: z.enum(["wallet_topup", "data_bundle", "airtime", "role_upgrade", "manual"]),
  label: z.string().trim().max(80).optional(),
  amount: z.number().positive().max(100000).optional(),
  package_id: uuid.optional(),
  network: z.enum(["MTN", "Telecel", "AT"]).optional(),
  duration_days: z.number().int().min(1).max(365).optional(),
}).strict()

export const PLATFORM_ENTRIES: CatalogEntry[] = [
  // ---- API v2
  mk({
    id: "api_v2.approvals.list", page: API_KEYS, summary: "List the pending live-key and API-access requests waiting for a decision, oldest first.",
    method: "GET", path: "/api/admin/api-v2/approvals", query: z.object({ q: z.string().max(100).optional(), page: pageNo.optional() }).strict(),
    kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["items[].id", "items[].kind", "items[].code", "items[].keyType", "items[].createdAt", "items[].owner.id", "items[].owner.name", "items[].owner.email", "items[].owner.role", "items[].owner.suspended", "items[].owner.eligible", "items[].owner.phoneVerified", "items[].owner.samePhoneAccounts", "items[].context.balance", "items[].context.topups30d", "items[].context.orders30d", "total"],
  }),
  mk({
    id: "api_v2.approvals.history", page: API_KEYS, summary: "Show the audit trail of API approvals and key changes, newest first.",
    method: "GET", path: "/api/admin/api-v2/approvals/history", query: z.object({ page: pageNo.optional() }).strict(), kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["items[].id", "items[].admin_id", "items[].action", "items[].target_user_id", "items[].new_value", "items[].created_at", "total"],
  }),
  mk({
    id: "api_v2.approvals.decide", page: API_KEYS, summary: "Approve or reject one live-key request or API-access request (the developer is told by message).",
    method: "POST", path: "/api/admin/api-v2/approvals/:id", params: { id: "uuid" },
    body: z.object({ kind: z.enum(["key", "swap", "access"]), action: z.enum(["approve", "reject"]), reason: reason.optional() }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: decideCard,
  }),
  mk({
    id: "api_v2.config.read", page: API_KEYS, summary: "Show the API v2 on/off switch, the roles allowed to use it, the approval WhatsApp contact and the active roles.",
    method: "GET", path: "/api/admin/api-v2/config", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["enabled", "allowed_roles", "approval_whatsapp", "roles[].slug", "roles[].name"],
  }),
  mk({
    id: "api_v2.config.update", page: API_KEYS, summary: "Switch API v2 on or off, change which roles may use it, or set the approval WhatsApp contact.",
    method: "PUT", path: "/api/admin/api-v2/config",
    body: z.object({ enabled: bool.optional(), allowed_roles: z.array(z.string().min(1).max(64)).max(100).optional(), approval_whatsapp: z.string().max(300).nullable().optional() }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: configUpdateCard,
  }),
  mk({
    id: "api_v2.grants.list", page: API_KEYS, summary: "List the people who have a personal API-only access grant.",
    method: "GET", path: "/api/admin/api-v2/grants", query: z.object({ page: pageNo.optional() }).strict(), kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["items[].userId", "items[].name", "items[].email", "items[].role", "items[].grantedAt", "total"],
  }),
  mk({
    id: "api_v2.grants.remove", page: API_KEYS, summary: "Remove a person's API-only access grant (their keys stop on the next request unless their role is allowed; they are told).",
    method: "DELETE", path: "/api/admin/api-v2/grants/:userId", params: { userId: "uuid" }, body: z.object({ reason }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: grantRemoveCard,
  }),
  mk({
    id: "api_v2.keys.list", page: API_KEYS, summary: "List API v2 keys with owner, status, limits, last use and 24-hour request count (never the key itself).",
    method: "GET", path: "/api/admin/api-v2/keys", query: z.object({ status: z.enum(["pending", "active", "revoked"]).optional(), type: keyType.optional() }).strict(),
    kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["keys[].id", "keys[].user_id", "keys[].key_type", "keys[].environment", "keys[].status", "keys[].name", "keys[].rate_limits", "keys[].last_used_at", "keys[].created_at", "keys[].approved_at", "keys[].revoked_at", "keys[].requests_24h", "keys[].owner.first_name", "keys[].owner.last_name", "keys[].owner.email", "keys[].owner.role"],
  }),
  mk({
    id: "api_v2.keys.update", page: API_KEYS, summary: "Approve, reject or revoke an API v2 key, or set or reset its per-minute limits.",
    method: "PATCH", path: "/api/admin/api-v2/keys/:id", params: { id: "uuid" },
    body: z.object({
      action: z.enum(["approve", "reject", "revoke", "set_limits", "reset_limits"]), reason: reason.optional(),
      limits: z.object({ purchase: z.number().int().min(1).max(10000).optional(), bulk: z.number().int().min(1).max(10000).optional(), balance: z.number().int().min(1).max(10000).optional(), status: z.number().int().min(1).max(10000).optional() }).strict().optional(),
    }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: keyPatchCard,
  }),
  mk({
    id: "api_v2.keys.activity", page: API_KEYS, summary: "Show the last 24 hours of activity for one API v2 key: requests, failures, speed, spend and orders.",
    method: "GET", path: "/api/admin/api-v2/keys/:id/activity", params: { id: "uuid" }, kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["activity.requests", "activity.ok", "activity.failed", "activity.successRate", "activity.avgLatencyMs", "activity.lastUsedAt", "activity.spent", "activity.orders", "activity.pending"],
  }),
  mk({
    id: "api_v2.logs", page: API_KEYS, summary: "Search the API v2 request log, newest first (no key prefixes or IP addresses).",
    method: "GET", path: "/api/admin/api-v2/logs",
    query: z.object({ keyId: uuid.optional(), userId: uuid.optional(), statusClass: z.enum(["success", "client_error", "server_error"]).optional(), since: isoDay.or(dateTime).optional(), until: isoDay.or(dateTime).optional(), endpoint: z.string().max(200).optional(), limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).max(100000).optional() }).strict(),
    kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["logs[].id", "logs[].key_id", "logs[].user_id", "logs[].method", "logs[].endpoint", "logs[].status_code", "logs[].error_code", "logs[].duration_ms", "logs[].environment", "logs[].created_at", "logs[].owner_email", "total"],
  }),
  mk({
    id: "api_v2.stats", page: API_KEYS, summary: "Show the API v2 overview for the last 24 hours: keys, requests, failures, speed, revenue, orders and the busiest developer.",
    method: "GET", path: "/api/admin/api-v2/stats", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["stats.totalKeys", "stats.pendingKeys", "stats.activeKeys", "stats.requests24h", "stats.successRate", "stats.failed24h", "stats.avgLatencyMs", "stats.top.name", "stats.top.email", "stats.top.requests", "stats.revenue24h", "stats.revenueLifetime", "stats.orders24h", "stats.pendingOrders24h"],
  }),
  mk({
    id: "api_v2.stuck", page: API_KEYS, summary: "List API v2 requests and orders that have been unfinished for over 10 minutes (read-only).",
    method: "GET", path: "/api/admin/api-v2/stuck", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["claims[].id", "claims[].user_id", "claims[].kind", "claims[].reference", "claims[].status", "claims[].created_at", "orders[].id", "orders[].user_id", "orders[].network", "orders[].api_reference", "orders[].status", "orders[].created_at"],
  }),

  // ---- API v2 admin console (announcements, developers, services, report, trend)
  mk({
    id: "api_v2.announcements.list", page: API_KEYS, summary: "List the API announcements with their text, severity, dates and whether each is active, scheduled or ended.",
    method: "GET", path: "/api/admin/api-v2/announcements", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["announcements[].id", "announcements[].title", "announcements[].body", "announcements[].severity", "announcements[].startsAt", "announcements[].endsAt", "announcements[].state"],
  }),
  mk({
    id: "api_v2.announcements.create", page: API_KEYS, summary: "Publish a new announcement on the API pages for developers, for a set period (at most 50 exist).",
    method: "POST", path: "/api/admin/api-v2/announcements",
    body: z.object({ title: z.string().trim().min(1).max(80), body: z.string().trim().min(1).max(1000), severity: z.enum(["info", "warning", "critical"]), startsAt: dateTime, endsAt: dateTime }).strict(),
    kind: "change", risk: "normal", auth: "admin", card: announcementSaveCard,
  }),
  mk({
    id: "api_v2.announcements.update", page: API_KEYS, summary: "Edit one API announcement: title, text, severity and the period it is shown.",
    method: "PUT", path: "/api/admin/api-v2/announcements/:id", params: { id: "uuid" },
    body: z.object({ title: z.string().trim().min(1).max(80), body: z.string().trim().min(1).max(1000), severity: z.enum(["info", "warning", "critical"]), startsAt: dateTime, endsAt: dateTime }).strict(),
    kind: "change", risk: "normal", auth: "admin", card: announcementSaveCard,
  }),
  mk({
    id: "api_v2.announcements.delete", page: API_KEYS, summary: "Delete one API announcement for good.",
    method: "DELETE", path: "/api/admin/api-v2/announcements/:id", params: { id: "uuid" },
    kind: "change", risk: "danger", auth: "admin", card: announcementDeleteCard,
  }),
  mk({
    id: "api_v2.developers.list", page: API_KEYS, summary: "List the developers with API v2 keys: 30-day requests, failures, spend, orders and whether they are paused (25 per page).",
    method: "GET", path: "/api/admin/api-v2/developers", query: z.object({ q: z.string().max(60).optional(), page: pageNo.optional() }).strict(),
    kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["items[].userId", "items[].name", "items[].email", "items[].role", "items[].keysActive", "items[].keysPending", "items[].requests", "items[].failed", "items[].successRate", "items[].spent", "items[].orders", "items[].lastUsedAt", "items[].granted", "items[].paused", "total", "page", "pageSize"],
  }),
  mk({
    id: "api_v2.developers.get", page: API_KEYS, summary: "Show one developer's API profile: totals, keys (no key material), personal grant and pause state.",
    method: "GET", path: "/api/admin/api-v2/developers/:userId", params: { userId: "uuid" }, kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["profile.user.id", "profile.user.name", "profile.user.email", "profile.user.role", "profile.user.suspended", "profile.totals.requests", "profile.totals.failed", "profile.totals.successRate", "profile.totals.spent", "profile.totals.orders", "profile.totals.pending", "profile.keys[].id", "profile.keys[].keyType", "profile.keys[].environment", "profile.keys[].status", "profile.keys[].name", "profile.keys[].lastUsedAt", "profile.grant.grantedAt", "profile.pause.pausedAt", "profile.pause.reason"],
  }),
  mk({
    id: "api_v2.developers.pause", page: API_KEYS, summary: "Pause or resume one developer's API v2 access (their keys stay approved but every request is refused while paused).",
    method: "POST", path: "/api/admin/api-v2/developers/:userId/pause", params: { userId: "uuid" },
    body: z.object({ paused: bool, reason: z.string().trim().max(200).optional() }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: developerPauseCard,
  }),
  mk({
    id: "api_v2.report", page: API_KEYS, summary: "Show the API business report: data orders and revenue by developer, product or month over a date range (counts only; no cost or profit figures).",
    method: "GET", path: "/api/admin/api-v2/report", query: z.object({ from: isoDay.optional(), to: isoDay.optional(), by: z.enum(["developer", "product", "month"]).optional() }).strict(),
    kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["from", "to", "by", "groups[].label", "groups[].orders", "groups[].revenue", "totals.orders", "totals.revenue", "other[].month", "other[].product", "other[].orders"],
  }),
  mk({
    id: "api_v2.services.list", page: API_KEYS, summary: "List the seven API services and whether each is paused, with its message.",
    method: "GET", path: "/api/admin/api-v2/services", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["services[].id", "services[].title", "services[].paused", "services[].message", "services[].updatedAt", "services[].missing"],
  }),
  mk({
    id: "api_v2.services.pause", page: API_KEYS, summary: "Pause or resume one API service for every developer (new requests are refused while paused).",
    method: "PUT", path: "/api/admin/api-v2/services/:service", params: { service: "slug" },
    body: z.object({ paused: bool, message: z.string().trim().max(200).nullable().optional() }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: servicePauseCard,
  }),
  mk({
    id: "api_v2.trend", page: API_KEYS, summary: "Show per-day API requests, failures and data revenue for the last 7, 30 or 90 days.",
    method: "GET", path: "/api/admin/api-v2/trend", query: z.object({ days: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional() }).strict(),
    kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["days", "points[].day", "points[].requests", "points[].failed", "points[].revenue"],
  }),

  // ---- API v1 retirement
  mk({
    id: "api_v1.retirement.read", page: API_KEYS, summary: "Show the API v1 retirement date, the exempt users, when the notice went out and who still used v1 in the last 7 days.",
    method: "GET", path: "/api/admin/api-v1/retirement", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["sunset_at", "exempt_users[].id", "exempt_users[].email", "exempt_users[].first_name", "notice_sent_at", "updated_at", "stragglers[].user_id", "stragglers[].email", "stragglers[].last_call", "stragglers[].calls_7d", "stragglers[].orders_7d", "stragglers[].exempt"],
  }),
  mk({
    id: "api_v1.retirement.update", page: API_KEYS, summary: "Set the API v1 retirement date and replace the whole list of exempt users (needs the updated_at value from the last read).",
    method: "PUT", path: "/api/admin/api-v1/retirement",
    body: z.object({ sunset_at: dateTime.nullable(), exempt_user_ids: z.array(uuid).max(50), expected_updated_at: z.string().min(1).max(64).refine((s) => !Number.isNaN(Date.parse(s)), "must be a date") }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: retirementCard,
  }),

  // ---- API v2 money protection (Release 5): read-only here; the limit and switch writes are excluded (fraud controls)
  mk({
    id: "api_v2.money.settings", page: API_KEYS, summary: "Show whether API daily spending limits and fraud warnings are switched on, the warning thresholds and today's alert count.",
    method: "GET", path: "/api/admin/api-v2/money-settings", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["capsEnabled", "alertsEnabled", "thresholds", "updatedAt", "alertsToday"],
  }),
  mk({
    id: "api_v2.developers.spend", page: API_KEYS, summary: "Show one developer's API spend today against their Datagod limit and each live key's limit, limit refusals today and their last 10 fraud alerts.",
    method: "GET", path: "/api/admin/api-v2/developers/:userId/spend-cap", params: { userId: "uuid" }, kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["today", "userCap", "keys[].keyId", "keys[].spent", "keys[].cap", "refusalsToday", "alerts[].signal", "alerts[].createdAt", "alerts[].details"],
  }),

  // ---- API v1 keys, kill switch, logs
  mk({
    id: "api_keys.list", page: API_KEYS, summary: "List API v1 keys with owner, status, limit and dates (never the key itself); optionally for one user.",
    method: "GET", path: "/api/admin/api-keys", query: z.object({ userId: uuid.optional() }).strict(), kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["keys[].id", "keys[].user_id", "keys[].name", "keys[].is_active", "keys[].rate_limit_per_min", "keys[].created_at", "keys[].updated_at", "keys[].last_used_at", "keys[].user.first_name", "keys[].user.last_name", "keys[].user.email", "keys[].user.role"],
  }),
  mk({
    id: "api_keys.update", page: API_KEYS, summary: "Switch an API v1 key on or off, or change its per-minute limit.",
    method: "PATCH", path: "/api/admin/api-keys", query: z.object({ id: uuid }).strict(),
    body: z.object({ is_active: bool.optional(), rate_limit_per_min: z.number().int().min(1).max(10000).optional() }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: v1UpdateCard,
  }),
  mk({
    id: "api_keys.delete", page: API_KEYS, summary: "Permanently delete an API v1 key.",
    method: "DELETE", path: "/api/admin/api-keys", query: z.object({ id: uuid }).strict(), kind: "change", risk: "danger", auth: "admin", card: v1DeleteCard,
  }),
  mk({
    id: "api_keys.global_kill", page: API_KEYS, summary: "Emergency stop: disable EVERY API v1 key, revoke EVERY API v2 key and switch the v2 API off for everyone.",
    method: "POST", path: "/api/admin/api-keys/global-kill", kind: "change", risk: "danger", auth: "admin", timeoutMs: 30000, card: globalKillCard,
  }),
  mk({
    id: "api_logs.list", page: API_KEYS, summary: "Search the API v1 request log (method, endpoint, status, speed; no request or response bodies, key prefixes or IP addresses).",
    method: "GET", path: "/api/admin/api-logs",
    query: z.object({
      userId: uuid.optional(), apiKeyId: uuid.optional(), statusCode: z.number().int().min(100).max(599).optional(), statusFilter: z.enum(["success", "client_error", "server_error"]).optional(),
      // The handler drops this into a filter string: plain characters only.
      search: z.string().max(100).regex(/^[A-Za-z0-9 /_.:-]*$/, "letters, numbers, spaces and / _ . : - only").optional(),
      startDate: isoDay.or(dateTime).optional(), endDate: isoDay.or(dateTime).optional(), limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).max(100000).optional(),
    }).strict(),
    kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["logs[].id", "logs[].user_id", "logs[].api_key_id", "logs[].method", "logs[].endpoint", "logs[].status_code", "logs[].duration_ms", "logs[].created_at", "logs[].user.email", "logs[].key.name", "count"],
  }),

  // ---- Leaderboard (Top Performers)
  mk({
    id: "leaderboard.overview", page: LEADERBOARD, summary: "Show one leaderboard period: the program switch, its prizes, live top 10 per board, frozen results, presets and the data bundles a prize can use.",
    method: "GET", path: "/api/admin/leaderboard", query: z.object({ kind: periodKind.optional(), anchor: isoDay.optional() }).strict(), kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: [
      "data.config", "data.period.kind", "data.period.label", "data.period.timeLeft", "data.period.ended", "data.period.row.id", "data.period.row.status", "data.period.row.rewards_enabled",
      "data.prizes[].id", "data.prizes[].board", "data.prizes[].rank", "data.prizes[].prize_type", "data.prizes[].label", "data.prizes[].amount", "data.prizes[].status",
      "data.results[].id", "data.results[].board", "data.results[].rank", "data.results[].fullName", "data.results[].total", "data.results[].orders", "data.results[].prize.label", "data.results[].prize.status",
      "data.standings.dashboard[].rank", "data.standings.dashboard[].userId", "data.standings.dashboard[].name", "data.standings.dashboard[].total", "data.standings.dashboard[].orders",
      "data.standings.shop[].rank", "data.standings.shop[].userId", "data.standings.shop[].name", "data.standings.shop[].total", "data.standings.shop[].orders",
      "data.presets[].id", "data.presets[].name", "data.presets[].label", "data.packages[].id", "data.packages[].label",
    ],
  }),
  mk({
    id: "leaderboard.exclusions.list", page: LEADERBOARD, summary: "List the users hidden from every leaderboard (test and staff accounts).",
    method: "GET", path: "/api/admin/leaderboard/exclusions", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["data.exclusions[].user_id", "data.exclusions[].name", "data.exclusions[].email", "data.exclusions[].reason", "data.exclusions[].created_at"],
  }),
  mk({
    id: "leaderboard.exclusions.add", page: LEADERBOARD, summary: "Hide a user (found by email) from every leaderboard.",
    method: "POST", path: "/api/admin/leaderboard/exclusions", body: z.object({ email: z.string().trim().min(3).max(254).refine((s) => s.includes("@"), "must be an email address"), reason: z.string().trim().max(200).optional() }).strict(),
    kind: "change", risk: "normal", auth: "admin", card: exclusionAddCard,
  }),
  mk({
    id: "leaderboard.exclusions.remove", page: LEADERBOARD, summary: "Put a hidden user back on the leaderboards.",
    method: "DELETE", path: "/api/admin/leaderboard/exclusions", query: z.object({ userId: uuid }).strict(), kind: "change", risk: "normal", auth: "admin", card: exclusionRemoveCard,
  }),
  mk({
    id: "leaderboard.presets.create", page: LEADERBOARD, summary: "Save a reusable prize template (sets no prize and pays nothing).",
    method: "POST", path: "/api/admin/leaderboard/presets", body: z.object({ name: z.string().trim().min(1).max(60), prize: prizeObject }).strict(),
    kind: "change", risk: "normal", auth: "admin", card: presetCreateCard,
  }),
  mk({
    id: "leaderboard.presets.delete", page: LEADERBOARD, summary: "Delete a prize template (prizes already set from it are not affected).",
    method: "DELETE", path: "/api/admin/leaderboard/presets/:id", params: { id: "uuid" }, kind: "change", risk: "normal", auth: "admin", card: presetDeleteCard,
  }),
  mk({
    id: "leaderboard.prizes.set", page: LEADERBOARD, summary: "Set the prize for one rank of an open period, replacing its current prize (pays nothing yet).",
    method: "POST", path: "/api/admin/leaderboard/prizes", body: z.object({ kind: periodKind, anchor: isoDay.optional(), board, rank: z.number().int().min(1).max(3), prize: prizeObject }).strict(),
    kind: "change", risk: "money", auth: "admin", card: prizeSetCard,
  }),
  mk({
    id: "leaderboard.prizes.cancel", page: LEADERBOARD, summary: "Cancel a leaderboard prize (it stays listed as cancelled and can never be reassigned).",
    method: "POST", path: "/api/admin/leaderboard/prizes/:id/cancel", params: { id: "uuid" }, kind: "change", risk: "danger", auth: "admin", card: prizeCancelCard,
  }),
  mk({
    id: "leaderboard.period.rewards", page: LEADERBOARD, summary: "Turn prizes on or off for one open period.",
    method: "POST", path: "/api/admin/leaderboard/period", body: z.object({ kind: periodKind, anchor: isoDay.optional(), rewards_enabled: bool }).strict(),
    kind: "change", risk: "normal", auth: "admin", card: periodRewardsCard,
  }),
  mk({
    id: "leaderboard.config.pause", page: LEADERBOARD, summary: "Pause or resume the Top Performers program for every user (users see a maintenance notice while paused).",
    method: "POST", path: "/api/admin/leaderboard/config", body: z.object({ paused: bool }).strict(), kind: "change", risk: "danger", auth: "admin", card: pauseCard,
  }),
  mk({
    id: "leaderboard.close", page: LEADERBOARD, summary: "Close an ended daily, weekly or monthly period: refresh totals, freeze the top 30 per board, give ranks 1 to 3 their prize and notify the podium. Cannot be undone. Yearly periods: use the page.",
    method: "POST", path: "/api/admin/leaderboard/close",
    // A yearly close refreshes twelve months of totals in one request (60 s limit), so it stays on the page.
    body: z.object({ kind: z.enum(["daily", "weekly", "monthly"]), anchor: isoDay.optional(), with_rewards: bool }).strict(),
    kind: "change", risk: "danger", auth: "admin", timeoutMs: 60000, card: closeCard,
  }),
  mk({
    id: "leaderboard.deliver", page: LEADERBOARD, summary: "Send one winner their prize: cash into their wallet, a dealer upgrade, or a free data or airtime order sent to the supplier.",
    method: "POST", path: "/api/admin/leaderboard/deliver", body: z.object({ result_id: uuid, phone: z.string().trim().max(20).optional() }).strict(),
    kind: "change", risk: "money", auth: "admin", timeoutMs: 60000, card: deliverCard,
  }),
  mk({
    id: "leaderboard.deliver.mark", page: LEADERBOARD, summary: "Record a winner's prize as delivered by hand (nothing is sent).",
    method: "POST", path: "/api/admin/leaderboard/deliver/mark", body: z.object({ result_id: uuid, note: z.string().trim().max(500).optional() }).strict(),
    kind: "change", risk: "normal", auth: "admin", card: markCard,
  }),

  // ---- Scheduled tasks (own bearer-token check: an admin sees and manages every task, anyone else only their own)
  mk({
    id: "scheduled_tasks.list", page: SCHEDULED, summary: "List the scheduled AI tasks with what each does, when it runs, whether it is active and how its last run went.",
    method: "GET", path: "/api/admin/scheduled-tasks", query: z.object({ scope: z.literal("own").optional() }).strict(), kind: "lookup", risk: "normal", auth: "other",
    resultKeep: ["tasks[].id", "tasks[].name", "tasks[].prompt", "tasks[].context", "tasks[].schedule_type", "tasks[].run_at_time", "tasks[].run_on_days", "tasks[].run_at_timestamp", "tasks[].notify_channels", "tasks[].next_run_at", "tasks[].last_run_at", "tasks[].last_success", "tasks[].is_active", "tasks[].user_id", "tasks[].created_at"],
  }),
  mk({
    id: "scheduled_tasks.read", page: SCHEDULED, summary: "Show one scheduled AI task in full, including its last result.",
    method: "GET", path: "/api/admin/scheduled-tasks/:id", params: { id: "uuid" }, kind: "lookup", risk: "normal", auth: "other",
    resultKeep: ["task.id", "task.name", "task.prompt", "task.context", "task.schedule_type", "task.run_at_time", "task.run_on_days", "task.run_at_timestamp", "task.notify_channels", "task.next_run_at", "task.last_run_at", "task.last_result", "task.last_success", "task.is_active", "task.user_id", "task.standing_order"],
  }),
  mk({
    id: "scheduled_tasks.create", page: SCHEDULED, summary: "Create a scheduled AI task that runs a prompt on its own at set times (UTC) and reports to the owner.",
    method: "POST", path: "/api/admin/scheduled-tasks",
    body: z.object({
      name: z.string().trim().min(1).max(120), prompt: z.string().trim().min(1).max(4000), context: z.enum(["admin", "dashboard"]).optional(),
      schedule_type: z.enum(["once", "hourly", "daily", "weekly"]), run_at_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
      run_on_days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(), run_at_timestamp: dateTime.optional(),
      notify_channels: z.array(z.enum(["push", "sms", "email"])).min(1).max(3).optional(),
    }).strict(),
    kind: "change", risk: "danger", auth: "other", card: taskCreateCard,
  }),
  mk({
    id: "scheduled_tasks.update", page: SCHEDULED, summary: "Pause or resume a scheduled AI task, or change its name or prompt (a standing order can only be paused or resumed).",
    method: "PATCH", path: "/api/admin/scheduled-tasks/:id", params: { id: "uuid" },
    body: z.object({ is_active: bool.optional(), name: z.string().trim().min(1).max(120).optional(), prompt: z.string().trim().min(1).max(4000).optional() }).strict(),
    kind: "change", risk: "danger", auth: "other", card: taskUpdateCard,
  }),
  mk({
    id: "scheduled_tasks.delete", page: SCHEDULED, summary: "Permanently delete a scheduled AI task.",
    method: "DELETE", path: "/api/admin/scheduled-tasks/:id", params: { id: "uuid" }, kind: "change", risk: "danger", auth: "other", card: taskDeleteCard,
  }),

  // ---- Security alerts
  mk({
    id: "security_alerts.list", page: SECURITY, summary: "List recent security alerts, newest first, with how many are not yet handled.",
    method: "GET", path: "/api/admin/security-alerts", query: z.object({ severity: z.enum(["critical", "high", "info"]).optional(), unacked: z.literal("1").optional(), limit: z.number().int().min(1).max(300).optional() }).strict(),
    kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["alerts[].id", "alerts[].created_at", "alerts[].severity", "alerts[].category", "alerts[].title", "alerts[].acknowledged_at", "unackedCount"],
  }),
  mk({
    id: "security_alerts.acknowledge", page: SECURITY, summary: "Mark one security alert, or every unhandled alert, as handled (nobody is blocked or unblocked).",
    method: "POST", path: "/api/admin/security-alerts", body: z.object({ action: z.enum(["acknowledge", "acknowledge_all"]), id: uuid.optional() }).strict(),
    kind: "change", risk: "normal", auth: "admin", card: alertCard,
  }),

  // ---- AI conversations (customer chat text is returned to admins only, for review)
  mk({
    id: "ai_conversations.list", page: AI, summary: "List assistant conversations with a short preview of the first customer message, flags and review status.",
    method: "GET", path: "/api/admin/ai-conversations",
    query: z.object({ context: z.enum(["home", "storefront", "dashboard"]).optional(), flagged: bool.optional(), reviewed: bool.optional(), from: isoDay.optional(), to: isoDay.optional(), page: z.number().int().min(1).max(999999).optional() }).strict(),
    kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["page", "total", "totalPages", "summary.conversations7d", "summary.unreviewedFlagged7d", "conversations[].id", "conversations[].context", "conversations[].audience", "conversations[].last_at", "conversations[].message_count", "conversations[].flagged", "conversations[].flag_reasons", "conversations[].reviewed_at", "conversations[].preview"],
  }),
  mk({
    id: "ai_conversations.read", page: AI, summary: "Read one assistant conversation: its flags and the messages (customer text may appear).",
    method: "GET", path: "/api/admin/ai-conversations/:id", params: { id: "uuid" }, kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["conversation.id", "conversation.context", "conversation.audience", "conversation.started_at", "conversation.last_at", "conversation.message_count", "conversation.flagged", "conversation.flag_reasons", "conversation.reviewed_at", "messages[].role", "messages[].text", "messages[].created_at"],
  }),
  mk({
    id: "ai_conversations.review", page: AI, summary: "Mark an assistant conversation as reviewed.",
    method: "POST", path: "/api/admin/ai-conversations/:id/review", params: { id: "uuid" }, kind: "change", risk: "normal", auth: "admin", card: reviewCard,
  }),

  // ---- Dashboard numbers (read-only RPCs)
  mk({
    id: "dashboard.stats", page: HOME, summary: "Show the dashboard headline numbers for Today, 7 days or 30 days: revenue, profit, orders, success rate, float, debtors and what needs attention.",
    method: "GET", path: "/api/admin/dashboard-stats", query: z.object({ range: z.enum(["today", "7d", "30d"]).optional() }).strict(), kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: [
      "totalUsers", "totalShops", "totalSubAgents", "totalOrders", "completedOrders", "totalRevenue", "successRate", "totalWalletBalance", "totalProfitBalance",
      "airtimeStats.totalAirtimeOrders", "airtimeStats.completedAirtimeOrders", "airtimeStats.airtimeRevenue",
      "range", "rangeRevenue", "rangeRevenuePrevious", "rangeProfit", "rangeOrders", "rangeCompletedOrders", "rangeSuccessRate", "todayOrders", "floatBalance",
      "debtorsTotal", "debtorsCount", "complaintsPending", "afaPending", "agentsExpiring", "pendingShops", "actionsTotal",
    ],
  }),
  mk({
    id: "dashboard.analytics", page: HOME, summary: "Show the dashboard breakdowns for Today, 7 days or 30 days: revenue by network, product and source, top packages, top agents and user growth.",
    method: "GET", path: "/api/admin/dashboard-analytics", query: z.object({ range: z.enum(["today", "7d", "30d"]).optional() }).strict(), kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: [
      "range", "byNetwork[].network", "byNetwork[].revenue", "byNetwork[].orders", "byProduct[].product", "byProduct[].revenue", "byProduct[].orders", "bySource[].source", "bySource[].revenue", "bySource[].orders",
      "topPackages[].network", "topPackages[].sizeGb", "topPackages[].revenue", "topPackages[].orders", "topAgents[].shopName", "topAgents[].revenue", "topAgents[].orders",
      "growth.new7d", "growth.new30d", "growth.expiring", "growth.roleMix[].role", "growth.roleMix[].count",
    ],
  }),
]
