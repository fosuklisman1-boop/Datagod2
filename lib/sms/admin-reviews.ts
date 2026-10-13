/** Admin review lists enriched with each account's user and mode (Phase 2 spec §4.4 / §7). */
import { createClient } from "@supabase/supabase-js"
import { listKycForAdmin, type PublicKyc } from "./kyc-service"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export interface AccountInfo { user_id: string; email: string | null; mode: "platform" | "business"; owner_type: string }

const CHUNK = 100
function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function attachAccounts<T extends { sms_account_id: string | null }>(
  rows: T[], info: Map<string, AccountInfo>
): (T & { account: AccountInfo | null })[] {
  return rows.map((r) => ({ ...r, account: r.sms_account_id ? info.get(r.sms_account_id) ?? null : null }))
}

export async function loadAccountInfo(accountIds: string[]): Promise<Map<string, AccountInfo>> {
  const ids = [...new Set(accountIds.filter(Boolean))]
  const map = new Map<string, AccountInfo>()
  if (ids.length === 0) return map
  const accounts: { id: string; user_id: string; mode: "platform" | "business"; owner_type: string }[] = []
  for (const part of chunks(ids, CHUNK)) {
    const { data, error } = await supabaseAdmin.from("sms_accounts").select("id, user_id, mode, owner_type").in("id", part)
    if (error) throw new Error(`sms_accounts lookup failed: ${error.message}`)
    accounts.push(...((data ?? []) as typeof accounts))
  }
  const emails = new Map<string, string | null>()
  for (const part of chunks([...new Set(accounts.map((a) => a.user_id))], CHUNK)) {
    const { data, error } = await supabaseAdmin.from("users").select("id, email").in("id", part)
    if (error) throw new Error(`users lookup failed: ${error.message}`)
    for (const u of (data ?? []) as { id: string; email: string | null }[]) emails.set(u.id, u.email)
  }
  for (const a of accounts) {
    map.set(a.id, { user_id: a.user_id, email: emails.get(a.user_id) ?? null, mode: a.mode, owner_type: a.owner_type })
  }
  return map
}

const REVIEW_STATUSES = new Set(["submitted", "approved", "rejected", "draft", "all"])
export type ReviewRow = PublicKyc & { account: AccountInfo | null }

export async function listBusinessReviews(status: string): Promise<ReviewRow[]> {
  const s = (REVIEW_STATUSES.has(status) ? status : "submitted") as Parameters<typeof listKycForAdmin>[0]
  const rows = await listKycForAdmin(s)
  const info = await loadAccountInfo(rows.map((r) => r.sms_account_id))
  return attachAccounts(rows, info)
}

const SENDER_STATUSES = new Set(["pending", "active", "paused", "rejected", "revoked"])
export interface SenderRow {
  id: string; sender_id: string; local_status: string; kyc_free: boolean; is_pool: boolean
  approved_at: string | null; revoked_at: string | null; rejection_reason: string | null
  submitted_at: string | null; created_at: string; sms_account_id: string | null
}

export async function listSenderIdsForAdmin(
  status: string, scope: "tenant" | "global" | "all" = "all"
): Promise<(SenderRow & { account: AccountInfo | null })[]> {
  let q = supabaseAdmin.from("sms_sender_ids")
    .select("id, sender_id, local_status, kyc_free, is_pool, approved_at, revoked_at, rejection_reason, submitted_at, created_at, sms_account_id")
    .order("created_at", { ascending: false }).limit(500)
  if (SENDER_STATUSES.has(status)) q = q.eq("local_status", status)
  if (scope === "tenant") q = q.not("sms_account_id", "is", null)
  if (scope === "global") q = q.is("sms_account_id", null)
  const { data, error } = await q
  if (error) throw new Error(`sender ids lookup failed: ${error.message}`)
  const rows = (data ?? []) as SenderRow[]
  const info = await loadAccountInfo(rows.map((r) => r.sms_account_id ?? ""))
  return attachAccounts(rows, info)
}
