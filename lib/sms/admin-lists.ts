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
export function listFlags(i: { severity: string; status: string; page: number }) {
  return listVia<Record<string, unknown>>("sms_admin_flags", {
    p_severity: FLAG_SEVERITIES.has(i.severity) ? i.severity : "",
    p_status: FLAG_STATUSES.has(i.status) ? i.status : "",
  }, i.page)
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
