import type { SupabaseClient } from "@supabase/supabase-js"
import { normalizeGhanaPhone } from "@/lib/phone-format"

export type Answer = "yes" | "no" | "no_answer"

/** A supplier's "yes" is trusted for 30 days; a "no" for one day (suppliers add numbers over time). */
export const YES_TTL_MS = 30 * 86_400_000
export const NO_TTL_MS = 86_400_000

const FUTURE_SKEW_MS = 5 * 60_000
const TABLE ="mtn_supplier_verdicts"

/**
 * Saved supplier verdicts that are still fresh. Phone is normalised to 0XXXXXXXXX.
 * Any read problem yields an empty map (the caller then asks the supplier).
 */
export async function getFreshVerdicts(
  db: SupabaseClient,
  phone: string,
  suppliers: string[],
  now: Date
): Promise<Map<string, "yes" | "no">> {
  const out = new Map<string, "yes" | "no">()
  const p = normalizeGhanaPhone(phone)
  if (!p || suppliers.length === 0) return out
  try {
    const { data, error } = await db.from(TABLE).select("supplier, verdict, checked_at").eq("phone", p).in("supplier", suppliers)
    if (error || !Array.isArray(data)) return new Map()
    for (const r of data as Array<{ supplier: string; verdict: string; checked_at: string }>) {
      if (r.verdict !== "yes" && r.verdict !== "no") continue
      const at = Date.parse(r.checked_at)
      if (Number.isNaN(at)) continue
      const ttl = r.verdict === "yes" ? YES_TTL_MS : NO_TTL_MS
      const age = now.getTime() - at
      // A stamp more than 5 minutes in the future is not trustworthy: stale.
      if (age >= -FUTURE_SKEW_MS && age < ttl) out.set(r.supplier, r.verdict)
    }
    return out
  } catch {
    return new Map()
  }
}

/** Upserts verdicts on (phone, supplier). Never throws; logs without any phone number. */
export async function saveVerdicts(
  db: SupabaseClient,
  rows: { phone: string; supplier: string; verdict: "yes" | "no" }[],
  now: Date
): Promise<void> {
  const stamped: { phone: string; supplier: string; verdict: "yes" | "no"; checked_at: string }[] = []
  for (const r of rows) {
    const phone = normalizeGhanaPhone(r.phone)
    if (!phone) continue
    stamped.push({ phone, supplier: r.supplier, verdict: r.verdict, checked_at: now.toISOString() })
  }
  if (stamped.length === 0) return
  try {
    const { error } = await db.from(TABLE).upsert(stamped, { onConflict: "phone,supplier" })
    if (error) console.error("[STRICT-VERIFY] saving supplier verdicts failed, rows:", stamped.length)
  } catch {
    console.error("[STRICT-VERIFY] saving supplier verdicts threw, rows:", stamped.length)
  }
}
