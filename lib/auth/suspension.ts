import type { SupabaseClient } from "@supabase/supabase-js"

export type SuspensionStatus = "active" | "suspended" | "unknown"

/**
 * Tri-state suspension read. 'suspended' = is_suspended true OR no users row at all (an orphaned account is never
 * served); 'unknown' = the read errored or threw (callers fail closed but can say "try again" instead of
 * "suspended"); 'active' = a row exists and is not suspended.
 * The log marker is fixed text; no user id, name, phone or email is ever logged.
 */
export async function suspensionStatus(db: SupabaseClient, userId: string): Promise<SuspensionStatus> {
  try {
    const { data, error } = await db.from("users").select("is_suspended").eq("id", userId).maybeSingle()
    if (error) {
      console.error("[AUTH] suspension_check_failed")
      return "unknown"
    }
    if (!data) {
      console.error("[AUTH] suspension_check_failed")
      return "suspended"
    }
    return (data as { is_suspended?: boolean | null }).is_suspended === true ? "suspended" : "active"
  } catch {
    console.error("[AUTH] suspension_check_failed")
    return "unknown"
  }
}

/** True unless the account is positively active. Fails CLOSED: unknown and suspended both count as suspended. */
export async function isSuspended(db: SupabaseClient, userId: string): Promise<boolean> {
  return (await suspensionStatus(db, userId)) !== "active"
}
