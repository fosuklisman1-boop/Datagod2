// Audit rows for admin API actions that do not go through the api_v2_* SQL functions (those write their own
// row in the same transaction): revoke, limits, config and the global kill. Never stores a key, hash or phone.
import type { SupabaseLike } from "./store"

export type ApiAuditAction =
  | "api_key_revoke"
  | "api_key_limits"
  | "api_config"
  | "api_global_kill"

/** Inserts one admin_audit_log row. Returns false (and logs) on any failure; never throws. */
export async function auditApi(
  client: SupabaseLike,
  r: { adminId: string | undefined; action: string; targetUserId?: string | null; before?: unknown; after?: unknown }
): Promise<boolean> {
  if (!r.adminId || !/^api_[a-z_]+$/.test(r.action)) return false
  try {
    const { error } = await client.from("admin_audit_log").insert({
      admin_id: r.adminId,
      action: r.action,
      target_user_id: r.targetUserId ?? null,
      old_value: r.before ?? null,
      new_value: r.after ?? null,
    })
    if (error) {
      console.error(`[ADMIN-AUDIT] ${r.action} insert failed`)
      return false
    }
    return true
  } catch {
    console.error(`[ADMIN-AUDIT] ${r.action} insert failed`)
    return false
  }
}
