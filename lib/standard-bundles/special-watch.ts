import type { SupabaseClient } from "@supabase/supabase-js"
import { shouldSendAlert } from "@/lib/hubtel-cs/float-alert"
import { DATA_ORDERS_TABLE } from "./admin"

/**
 * Special Bundles stuck-children watch (final review I1). If the function instance dies inside the after() dispatch
 * loop, children never claimed stay pending + paid with no Hubtel reference, and nothing else would tell an admin.
 * READ-ONLY on hubtel_data_orders: it only finds such groups and sends ONE urgent alert per group, at most once every
 * 6 hours per group (stamps in one admin_settings key, the float-alert debounce pattern). Before migration 0141 (the
 * column is missing, SQLSTATE 42703) it skips silently. Runs from /api/cron/expire-stale-bot-orders.
 */

/** Older than this, a pending + paid child is not still waiting in a live dispatch loop (route maxDuration is 300s). */
export const SPECIAL_WATCH_AGE_MS = 5 * 60_000
export const SPECIAL_WATCH_REALERT_MS = 6 * 3_600_000
export const SPECIAL_WATCH_KEY = "last_special_stuck_alerts"
/** Rows read per run (a group is at most 50 children). */
export const SPECIAL_WATCH_LIMIT = 1000

export function specialStuckMessage(groupId: string, k: number): string {
  return `Special group ${groupId}: ${k} paid units not sent; send them from Admin > Hubtel Commission > Standard Bundles`
}

export interface SpecialWatchDeps {
  /** Urgent admin alert (SMS with email fallback). Throws on failure (the group is then not stamped). */
  alert(message: string): Promise<void>
  now?: () => number
}
export interface SpecialWatchResult { skipped: boolean; groups: number; alerted: number }

export async function watchStuckSpecialGroups(db: SupabaseClient, deps: SpecialWatchDeps): Promise<SpecialWatchResult> {
  const now = (deps.now ?? Date.now)()
  const { data, error } = await db.from(DATA_ORDERS_TABLE)
    .select("special_group_id")
    .not("special_group_id", "is", null)
    .eq("payment_status", "paid")
    .eq("status", "pending")
    .is("hubtel_client_reference", null)
    .lt("created_at", new Date(now - SPECIAL_WATCH_AGE_MS).toISOString())
    .limit(SPECIAL_WATCH_LIMIT)
  if (error) {
    if ((error as { code?: string }).code === "42703") return { skipped: true, groups: 0, alerted: 0 }
    throw error
  }

  const counts = new Map<string, number>()
  for (const r of (data ?? []) as { special_group_id: string | null }[]) {
    if (r.special_group_id) counts.set(r.special_group_id, (counts.get(r.special_group_id) ?? 0) + 1)
  }

  const stamp = await db.from("admin_settings").select("value").eq("key", SPECIAL_WATCH_KEY).maybeSingle()
  if (stamp.error) throw stamp.error
  const stored = stamp.data?.value?.groups
  const prev: Record<string, string> = stored && typeof stored === "object" ? stored as Record<string, string> : {}

  // Keep stamps only for groups still stuck: a group that recovers and gets stuck again is alerted afresh.
  const next: Record<string, string> = {}
  let alerted = 0
  for (const [g, k] of counts) {
    if (!shouldSendAlert(prev[g], new Date(now), SPECIAL_WATCH_REALERT_MS)) { next[g] = prev[g]; continue }
    try {
      await deps.alert(specialStuckMessage(g, k))
      next[g] = new Date(now).toISOString()
      alerted++
    } catch (e) {
      console.error("[bundles] special stuck alert failed:", g, e instanceof Error ? e.message : String(e))
      if (prev[g]) next[g] = prev[g]
    }
  }

  if (JSON.stringify(next) !== JSON.stringify(prev) && !(Object.keys(next).length === 0 && !stamp.data)) {
    const { error: upErr } = await db.from("admin_settings").upsert(
      { key: SPECIAL_WATCH_KEY, value: { groups: next }, description: "Special Bundles stuck-units alert debounce", updated_at: new Date(now).toISOString() },
      { onConflict: "key" },
    )
    if (upErr) console.error("[bundles] special stuck alert stamp failed:", upErr.message ?? upErr)
  }
  return { skipped: false, groups: counts.size, alerted }
}
