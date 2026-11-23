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

/** Saved verdicts older than this are deleted by the re-check cron (a "yes" is only trusted for 30 days anyway). */
export const VERDICT_RETENTION_MS = 30 * 86_400_000
export const VERDICT_PRUNE_BATCH = 1000

/**
 * Deletes verdicts with checked_at older than 30 days, at most 1,000 per call (oldest first). The table has a
 * composite key and no id, so the batch is bounded by its newest timestamp: rows strictly older than it go (the rows
 * sharing that last timestamp wait for the next run). Never throws; logs the error code only, never a phone.
 */
export async function pruneOldVerdicts(db: SupabaseClient, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - VERDICT_RETENTION_MS).toISOString()
  const codeOf = (e: unknown) => (e && typeof e === "object" && "code" in e ? String((e as { code?: unknown }).code ?? "error") : "error")
  try {
    const { data, error } = await db
      .from(TABLE)
      .select("checked_at")
      .lt("checked_at", cutoff)
      .order("checked_at", { ascending: true })
      .limit(VERDICT_PRUNE_BATCH)
    if (error) {
      console.error("[STRICT-VERIFY] verdict prune read failed:", codeOf(error))
      return 0
    }
    const stamps = (Array.isArray(data) ? data : []).map((r: { checked_at: string }) => r.checked_at).filter(Boolean)
    if (stamps.length === 0) return 0
    const first = stamps[0]
    const last = stamps[stamps.length - 1]
    // A short batch is everything older than the cutoff. A full batch stops before its newest timestamp (so it never
    // deletes more than it read); if the whole batch shares one timestamp, that one upsert batch goes together.
    const q = db.from(TABLE).delete()
    const { error: delErr } = stamps.length < VERDICT_PRUNE_BATCH
      ? await q.lt("checked_at", cutoff)
      : first === last
        ? await q.lte("checked_at", last)
        : await q.lt("checked_at", last)
    if (delErr) {
      console.error("[STRICT-VERIFY] verdict prune delete failed:", codeOf(delErr))
      return 0
    }
    return stamps.length
  } catch {
    console.error("[STRICT-VERIFY] verdict prune threw")
    return 0
  }
}
