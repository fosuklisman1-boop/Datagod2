import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * True when the account is suspended. Fails CLOSED: a read error, a thrown error or a missing users row all
 * count as suspended, so a database hiccup can never let a suspended account through.
 * The log marker is fixed text; no user id, name, phone or email is ever logged.
 */
export async function isSuspended(db: SupabaseClient, userId: string): Promise<boolean> {
  try {
    const { data, error } = await db.from("users").select("is_suspended").eq("id", userId).maybeSingle()
    if (error || !data) {
      console.error("[AUTH] suspension_check_failed")
      return true
    }
    return (data as { is_suspended?: boolean | null }).is_suspended === true
  } catch {
    console.error("[AUTH] suspension_check_failed")
    return true
  }
}
