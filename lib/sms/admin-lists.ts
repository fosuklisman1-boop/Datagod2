/** Searchable, paged admin lists + flag actions (Phase 2 spec §4.2). Heavy lifting is in SQL functions. */
import { createClient } from "@supabase/supabase-js"
import { dismissFlag, suspendSmsAccount, writeAuditLog } from "./moderation-service"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export const PAGE_SIZE = 25
const MESSAGE_STATUSES = new Set(["queued", "sending", "sent", "partial", "failed", "blocked", "held", "scheduled"])
const FLAG_SEVERITIES = new Set(["fraud", "info"])
const FLAG_STATUSES = new Set(["open", "dismissed", "actioned"])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface Page<T> { rows: T[]; total: number; page: number; pageSize: number }

export function parsePage(raw: string | null | undefined): number {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 100000) : 1
}
export function cleanQuery(raw: string | null | undefined): string {
  return (raw ?? "").trim().slice(0, 100)
}

function toPage<T extends { total_count?: string | number }>(data: T[] | null, page: number): Page<Omit<T, "total_count">> {
  const list = data ?? []
  const total = list.length ? Number(list[0].total_count) || 0 : 0
  return { rows: list.map(({ total_count: _t, ...rest }) => rest), total, page, pageSize: PAGE_SIZE }
}

async function listVia<T>(fn: string, args: Record<string, unknown>, page: number) {
  const { data, error } = await supabaseAdmin.rpc(fn, { ...args, p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE })
  if (error) throw new Error(error.message)
  return toPage(data as (T & { total_count?: string | number })[] | null, page)
}

export function listMessages(i: { q: string; status: string; page: number }) {
  return listVia<Record<string, unknown>>("sms_admin_messages", { p_q: cleanQuery(i.q), p_status: MESSAGE_STATUSES.has(i.status) ? i.status : "" }, i.page)
}
export function listAccounts(i: { q: string; page: number }) {
  return listVia<Record<string, unknown>>("sms_admin_accounts", { p_q: cleanQuery(i.q) }, i.page)
}
/** A campaign held for review (one row per held send log; a >500 send has one log per chunk). */
export interface HeldRow {
  id: string            // "held:<logId>" — never collides with sms_flags uuids / legacy numeric ids
  source: "held"
  log_id: number
  sms_account_id: string
  user_id: string | null
  email: string | null
  severity: "info"
  status: "open"
  reason: string        // the policy's (customer-facing) hold reason
  code: string | null
  message: string
  sender_id: string | null
  recipients_count: number
  segments: number
  credits_reserved: number
  created_at: string
}

export const HELD_LIMIT = 100

/** Held campaigns, oldest first (first in, first reviewed). Throws on a DB error. */
export async function listHeldCampaigns(): Promise<{ rows: HeldRow[]; total: number }> {
  const { data, error, count } = await supabaseAdmin
    .from("sms_send_logs")
    .select("id, sms_account_id, message, sender_id, recipients_count, segments, credits_reserved, created_at, policy_shadow", { count: "exact" })
    .eq("status", "held")
    .order("created_at", { ascending: true })
    .limit(HELD_LIMIT)
  if (error) throw new Error(error.message)
  const logs = (data ?? []) as {
    id: number | string; sms_account_id: string; message: string; sender_id: string | null; recipients_count: number
    segments: number; credits_reserved: number; created_at: string; policy_shadow: { reason?: unknown; code?: unknown } | null
  }[]
  if (logs.length === 0) return { rows: [], total: count ?? 0 }

  // Owner + email: best-effort (a lookup hiccup must not hide the held campaigns).
  const owners = new Map<string, string>()
  const emails = new Map<string, string>()
  try {
    const acctIds = [...new Set(logs.map((l) => l.sms_account_id))]
    const { data: accts } = await supabaseAdmin.from("sms_accounts").select("id, user_id").in("id", acctIds)
    for (const a of (accts ?? []) as { id: string; user_id: string }[]) owners.set(a.id, a.user_id)
    const userIds = [...new Set(owners.values())]
    if (userIds.length > 0) {
      const { data: users } = await supabaseAdmin.from("users").select("id, email").in("id", userIds)
      for (const u of (users ?? []) as { id: string; email: string | null }[]) if (u.email) emails.set(u.id, u.email)
    }
  } catch (e) {
    console.error("[SMS-ADMIN] held owner lookup failed:", e)
  }

  const rows: HeldRow[] = logs.map((l) => {
    const userId = owners.get(l.sms_account_id) ?? null
    const reason = typeof l.policy_shadow?.reason === "string" && l.policy_shadow.reason ? l.policy_shadow.reason : "Held for review"
    return {
      id: `held:${l.id}`, source: "held", log_id: Number(l.id), sms_account_id: l.sms_account_id,
      user_id: userId, email: userId ? emails.get(userId) ?? null : null,
      severity: "info", status: "open", reason,
      code: typeof l.policy_shadow?.code === "string" ? l.policy_shadow.code : null,
      message: l.message, sender_id: l.sender_id, recipients_count: Number(l.recipients_count) || 0,
      segments: Number(l.segments) || 0, credits_reserved: Number(l.credits_reserved) || 0, created_at: l.created_at,
    }
  })
  return { rows, total: count ?? rows.length }
}

/**
 * Flags page + (page 1 only) the campaigns held for review. Held campaigns are 'info'/'open', so
 * they are included when those filters allow them; they are listed separately from the paged
 * flags because they are actioned differently (release / reject instead of dismiss / suspend).
 */
export async function listFlags(i: { severity: string; status: string; page: number }) {
  const severity = FLAG_SEVERITIES.has(i.severity) ? i.severity : ""
  const status = FLAG_STATUSES.has(i.status) ? i.status : ""
  const wantHeld = i.page === 1 && (severity === "" || severity === "info") && (status === "" || status === "open")
  const [page, held] = await Promise.all([
    listVia<Record<string, unknown>>("sms_admin_flags", { p_severity: severity, p_status: status }, i.page),
    wantHeld ? listHeldCampaigns() : Promise.resolve({ rows: [] as HeldRow[], total: 0 }),
  ])
  return { ...page, held: held.rows, heldTotal: held.total }
}

export type FlagActionResult = { ok: true } | { ok: false; error: string }

/** Dismiss or suspend-from a flag. source "flag" = sms_flags row (uuid); "legacy" = flagged send log (numeric id). */
export async function actOnFlag(
  adminId: string,
  source: "flag" | "legacy",
  id: string,
  action: "dismiss" | "suspend"
): Promise<FlagActionResult> {
  if (source !== "flag" && source !== "legacy") return { ok: false, error: "Unknown flag source" }
  if (action !== "dismiss" && action !== "suspend") return { ok: false, error: "Unknown action" }
  if (source === "flag" && !UUID_RE.test(id)) return { ok: false, error: "Invalid flag id" }
  if (source === "legacy" && !/^\d+$/.test(id)) return { ok: false, error: "Invalid flag id" }

  const now = new Date().toISOString()

  if (action === "dismiss") {
    if (source === "legacy") {
      const r = await dismissFlag(adminId, id)
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    }
    const { data, error } = await supabaseAdmin.from("sms_flags")
      .update({ status: "dismissed", resolved_by: adminId, resolved_at: now })
      .eq("id", id).eq("status", "open").select("id")
    if (error) return { ok: false, error: error.message }
    if (!data || data.length === 0) return { ok: false, error: "Flag not found or already resolved" }
    await writeAuditLog(adminId, "sms_flag_dismiss", null, { id, status: "open" }, { id, status: "dismissed" }).catch(() => {})
    return { ok: true }
  }

  // suspend: find the account behind the flag
  const lookup = source === "flag"
    ? await supabaseAdmin.from("sms_flags").select("sms_account_id, status").eq("id", id).maybeSingle()
    : await supabaseAdmin.from("sms_send_logs").select("sms_account_id, flagged").eq("id", Number(id)).maybeSingle()
  const row = lookup.data as { sms_account_id?: string; status?: string; flagged?: boolean } | null
  const accountId = row?.sms_account_id
  if (lookup.error || !row || !accountId) return { ok: false, error: "Flag not found" }
  const open = source === "flag" ? row.status === "open" : row.flagged === true
  if (!open) return { ok: false, error: "Flag already resolved" }

  const owner = await supabaseAdmin.from("sms_accounts").select("user_id").eq("id", accountId).maybeSingle()
  const ownerId = (owner.data as { user_id?: string } | null)?.user_id ?? null

  const s = await suspendSmsAccount(adminId, accountId, true)
  if (!s.ok) return { ok: false, error: s.error }

  const resolveFailed = { ok: false as const, error: "Account suspended, but the flag could not be marked actioned" }
  const res = source === "flag"
    ? await supabaseAdmin.from("sms_flags")
        .update({ status: "actioned", resolved_by: adminId, resolved_at: now })
        .eq("id", id).eq("status", "open").select("id")
    : await supabaseAdmin.from("sms_send_logs")
        .update({ flagged: false, flag_reason: null })
        .eq("id", Number(id)).eq("flagged", true).select("id")
  if (res.error || !res.data || res.data.length === 0) return resolveFailed

  await writeAuditLog(adminId, "sms_flag_suspend", ownerId, { source, id }, { status: "actioned", accountId }).catch(() => {})
  return { ok: true }
}
