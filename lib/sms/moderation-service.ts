import { createClient } from "@supabase/supabase-js"
import { aggregateRevenue, type RawRevenueSums } from "./revenue-aggregation"
import type { Bundle } from "./bundle-service"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ---------- Types ----------

export interface SmsAccountRow {
  id: string
  user_id: string
  owner_type: string
  unit_balance: number
  status: string
  activated_at: string | null
  amount_paid: number | null
  created_at: string
}

export interface FlaggedLogRow {
  id: string
  sms_account_id: string
  message: string
  recipients_count: number
  segments: number
  credits_used: number
  status: string
  flagged: boolean
  flag_reason: string | null
  created_at: string
}

export interface SmsAdminDashboard {
  settings: Record<string, unknown>
  bundles: Bundle[]
  revenue: {
    activations: number
    activationTotal: number
    bundleTotal: number
    creditsSold: number
  }
  flagged: FlaggedLogRow[]
  accounts: SmsAccountRow[]
  suspendedAccountIds: string[]
}

// ---------- Helpers ----------

/** Fetch SMS-related settings from tenant_global_settings as a plain key→value map. */
async function fetchSmsSettings(): Promise<Record<string, unknown>> {
  const SMS_KEYS = [
    "sms_activation_fee",
    "sms_welcome_bonus_credits",
    "sms_blocked_keywords",
    "sms_allowed_link_domains",
    "sms_feature_enabled",
  ]
  const { data } = await supabaseAdmin
    .from("tenant_global_settings")
    .select("key, value")
    .in("key", SMS_KEYS)
  if (!data) return {}
  return Object.fromEntries(data.map((r: { key: string; value: unknown }) => [r.key, r.value]))
}

/** Write one admin_audit_log row. Fire-and-forget — never throws to the caller. */
async function writeAuditLog(
  adminId: string,
  action: string,
  targetUserId: string | null,
  oldValue: unknown,
  newValue: unknown
): Promise<void> {
  await supabaseAdmin.from("admin_audit_log").insert({
    admin_id: adminId,
    action,
    target_user_id: targetUserId ?? null,
    old_value: oldValue ? JSON.parse(JSON.stringify(oldValue)) : null,
    new_value: newValue ? JSON.parse(JSON.stringify(newValue)) : null,
  })
}

// ---------- Public API ----------

/** Full admin dashboard snapshot: settings, bundles, revenue, flagged logs, all accounts. */
export async function getSmsAdminDashboard(): Promise<SmsAdminDashboard> {
  const [settings, bundles, accounts, flagged, revRow] = await Promise.all([
    fetchSmsSettings(),
    supabaseAdmin.from("sms_bundles").select("*").order("price_ghs", { ascending: true }),
    supabaseAdmin.from("sms_accounts").select("*").order("created_at", { ascending: false }),
    supabaseAdmin
      .from("sms_send_logs")
      .select("*")
      .eq("flagged", true)
      .order("created_at", { ascending: false })
      .limit(100),
    supabaseAdmin.rpc("get_sms_revenue_summary"),
  ])

  const rawSums: RawRevenueSums = revRow.data?.[0] ?? {
    activationCount: null,
    activationTotal: null,
    bundleUnitsSold: null,
    bundleGhsTotal: null,
  }

  const allAccounts = (accounts.data ?? []) as SmsAccountRow[]
  const suspendedAccountIds = allAccounts
    .filter((a) => a.status === "suspended")
    .map((a) => a.id)

  return {
    settings,
    bundles: (bundles.data ?? []) as Bundle[],
    revenue: aggregateRevenue(rawSums),
    flagged: (flagged.data ?? []) as FlaggedLogRow[],
    accounts: allAccounts,
    suspendedAccountIds,
  }
}

/**
 * Toggle an SMS account's status between active and suspended.
 * Calls the suspend_sms_account RPC (atomically guards against touching inactive accounts),
 * then writes an admin_audit_log row. Returns the new status string.
 */
export async function suspendSmsAccount(
  adminId: string,
  accountId: string,
  suspended: boolean
): Promise<{ ok: true; newStatus: string } | { ok: false; error: string }> {
  // Fetch old status for audit log
  const { data: acct, error: fetchErr } = await supabaseAdmin
    .from("sms_accounts")
    .select("status, user_id")
    .eq("id", accountId)
    .maybeSingle()
  if (fetchErr || !acct) return { ok: false, error: "SMS account not found" }

  const { data: newStatus, error: rpcErr } = await supabaseAdmin.rpc("suspend_sms_account", {
    p_account_id: accountId,
    p_suspended: suspended,
  })
  if (rpcErr) return { ok: false, error: rpcErr.message }

  const action = suspended ? "sms_suspend" : "sms_unsuspend"
  await writeAuditLog(
    adminId,
    action,
    (acct as { status: string; user_id: string }).user_id,
    { status: (acct as { status: string; user_id: string }).status },
    { status: newStatus }
  ).catch((err) => console.error("[SMS-AUDIT] writeAuditLog failed:", err))

  return { ok: true, newStatus: newStatus as string }
}

/**
 * Dismiss a flagged send-log row by clearing its flagged column.
 * Returns 404 if the row does not exist or is already unflagged.
 * Writes an admin_audit_log row on success.
 */
export async function dismissFlag(
  adminId: string,
  logId: string
): Promise<{ ok: true } | { ok: false; error: string; status: 400 | 404 }> {
  const { data: row, error: fetchErr } = await supabaseAdmin
    .from("sms_send_logs")
    .select("id, sms_account_id, flagged, flag_reason")
    .eq("id", logId)
    .maybeSingle()

  if (fetchErr || !row) return { ok: false, error: "Log entry not found", status: 404 }
  if (!(row as { flagged: boolean }).flagged)
    return { ok: false, error: "Log entry is not flagged", status: 404 }

  const { error: updateErr } = await supabaseAdmin
    .from("sms_send_logs")
    .update({ flagged: false, flag_reason: null })
    .eq("id", logId)
  if (updateErr) return { ok: false, error: updateErr.message, status: 400 }

  await writeAuditLog(
    adminId,
    "sms_flag_dismiss",
    null,
    { flagged: true, flag_reason: (row as { flag_reason: string | null }).flag_reason },
    { flagged: false }
  ).catch((err) => console.error("[SMS-AUDIT] writeAuditLog failed:", err))

  return { ok: true }
}

/**
 * Upsert SMS-related keys into tenant_global_settings.
 * Only keys from the SMS allowlist are accepted.
 */
export async function updateSmsSettings(
  patch: Record<string, unknown>
): Promise<{ ok: true; updated: string[] } | { ok: false; error: string }> {
  const ALLOWED_KEYS = new Set([
    "sms_activation_fee",
    "sms_welcome_bonus_credits",
    "sms_blocked_keywords",
    "sms_allowed_link_domains",
    "sms_feature_enabled",
  ])

  const updates = Object.entries(patch).filter(([k]) => ALLOWED_KEYS.has(k))
  if (updates.length === 0) return { ok: false, error: "No valid settings keys provided" }

  const upsertRows = updates.map(([key, value]) => ({
    key,
    value,
    updated_at: new Date().toISOString(),
  }))

  const { error } = await supabaseAdmin
    .from("tenant_global_settings")
    .upsert(upsertRows, { onConflict: "key" })

  if (error) return { ok: false, error: error.message }
  return { ok: true, updated: updates.map(([k]) => k) }
}
