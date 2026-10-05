import type { SupabaseClient } from "@supabase/supabase-js"
import { normalizeGhanaPhone } from "@/lib/phone-format"

/** True when a PostgREST/Postgres error means the payer_phone column has not been migrated yet. */
export function isMissingPayerPhoneColumn(message: string | undefined | null): boolean {
  const m = message ?? ""
  return /payer_phone/i.test(m) && /(does not exist|schema cache|could not find)/i.test(m)
}

/**
 * Payer MoMo numbers (normalised local form) keyed by payment reference. Separate from the main refund
 * load so a not-yet-migrated column degrades to "no payer number" instead of breaking it. Other errors throw.
 */
export async function loadPayerPhones(db: SupabaseClient, references: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const refs = [...new Set(references.filter(Boolean))]
  for (let i = 0; i < refs.length; i += 100) {
    const { data, error } = await db.from("payment_attempts").select("reference, payer_phone").in("reference", refs.slice(i, i + 100))
    if (error) {
      if (isMissingPayerPhoneColumn(error.message)) return new Map()
      throw new Error(`[REFUND] payment_attempts payer lookup failed: ${error.message}`)
    }
    for (const row of (data ?? []) as { reference: string; payer_phone: string | null }[]) {
      const phone = row.payer_phone ? normalizeGhanaPhone(row.payer_phone) : null
      if (phone) out.set(row.reference, phone)
    }
  }
  return out
}

/**
 * Record the payer number after a direct MoMo charge was accepted. NEVER throws and is never part of
 * the original payment_attempts insert: the base row (same shape the hosted path writes) is inserted
 * first (duplicate reference is ignored), then payer_phone is written by a separate UPDATE so a missing
 * column cannot break checkout.
 */
export async function recordPayerPhone(
  db: SupabaseClient,
  args: { reference: string; rawPhone: string; baseRow: Record<string, unknown> }
): Promise<void> {
  try {
    const phone = normalizeGhanaPhone(args.rawPhone)
    if (!phone) return
    const ins = await db.from("payment_attempts").insert([args.baseRow])
    if (ins.error && ins.error.code !== "23505") {
      console.warn("[REFUND] payment_attempts base insert failed (non-fatal):", ins.error.message)
    }
    const { error } = await db.from("payment_attempts").update({ payer_phone: phone }).eq("reference", args.reference)
    if (error) console.warn("[REFUND] could not record payer_phone (non-fatal):", error.message)
  } catch (e) {
    console.warn("[REFUND] recordPayerPhone failed (non-fatal):", e instanceof Error ? e.message : e)
  }
}
