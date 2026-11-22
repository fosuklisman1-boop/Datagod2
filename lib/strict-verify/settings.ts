import type { SupabaseClient } from "@supabase/supabase-js"

export const STRICT_VERIFY_KEY = "mtn_strict_supplier_verification"

/**
 * The strict per-supplier MTN verification switch. A missing row is OFF (the
 * feature ships off); a read error is ON (fail safe: never send an unchecked
 * number because a read failed).
 */
export async function isStrictVerifyOn(db: SupabaseClient): Promise<boolean> {
  try {
    const { data, error } = await db.from("admin_settings").select("value").eq("key", STRICT_VERIFY_KEY).maybeSingle()
    if (error) return true
    if (!data) return false
    return (data as { value?: { enabled?: unknown } | null }).value?.enabled === true
  } catch {
    return true
  }
}
