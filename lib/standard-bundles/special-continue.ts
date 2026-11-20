import type { SupabaseClient } from "@supabase/supabase-js"
import { DATA_ORDERS_TABLE, fetchLedgerOrderIds, fetchSpecialGroupSizes } from "./admin"
import type { BundlesDeps } from "./service"
import { dispatchSpecialGroup, DISPATCH_BUDGET_MS } from "./special-service"
import { SPECIAL_WATCH_AGE_MS } from "./special-watch"

/** Rows taken per run. MUST stay <= 200: fetchLedgerOrderIds only checks the first 200 ids it is given. */
export const SPECIAL_CONTINUE_LIMIT = 200

/**
 * Special Bundles continuation (2026-11-20). The paced send loop (dispatchSpecialGroup) waits for Hubtel to settle each
 * unit before sending the next, so a large group does not fit the request's 240s budget; the units left are pending +
 * paid and are sent from here (cron /api/cron/expire-stale-bot-orders, in after()).
 * Only units NEVER attempted are taken: pending + paid, no Hubtel reference, notes NULL (any send attempt, release or
 * retry writes a note), no Hubtel ledger row at all, untouched for SPECIAL_WATCH_AGE_MS (so no live loop owns them).
 * Each send still goes through dispatchBundleOrder's atomic pending -> processing claim. Anything else stays with the
 * stuck watch (urgent alert) and the admin page.
 */

export interface UnsentChild { id: string; special_group_id: string; special_index: number }

export interface SpecialContinueDeps {
  /** Never-attempted Special children (see above). Throws on read error. */
  listUnsent(): Promise<UnsentChild[]>
  /** Ids (of the given) with ANY hubtel_cs_transactions row. Throws on read error (callers fail closed). */
  ledgerOrderIds(ids: string[]): Promise<Set<string>>
  /** Children per group. May throw (the highest unsent index is then used as N, for alert text only). */
  groupSizes(groupIds: string[]): Promise<Map<string, number>>
  dispatchGroup(groupId: string, ids: string[], n: number, startedAt: number): Promise<void>
  now(): number
}

export interface SpecialContinueResult { groups: number; units: number; skippedLedger: number }

export async function continueSpecialGroups(d: SpecialContinueDeps, startedAt: number): Promise<SpecialContinueResult> {
  // Defensive cap (see SPECIAL_CONTINUE_LIMIT): a row past 200 would come back "no ledger row" unchecked.
  const rows = (await d.listUnsent()).slice(0, SPECIAL_CONTINUE_LIMIT)
  if (rows.length === 0) return { groups: 0, units: 0, skippedLedger: 0 }

  const withLedger = await d.ledgerOrderIds(rows.map(r => r.id))
  const byGroup = new Map<string, UnsentChild[]>()
  for (const r of rows) {
    if (withLedger.has(r.id)) continue
    const list = byGroup.get(r.special_group_id) ?? []
    list.push(r)
    byGroup.set(r.special_group_id, list)
  }

  let sizes = new Map<string, number>()
  try { sizes = await d.groupSizes([...byGroup.keys()]) } catch (e) {
    console.error("[bundles] special continue: group size read failed:", e instanceof Error ? e.message : String(e))
  }

  let groups = 0
  let units = 0
  for (const [groupId, kids] of byGroup) {
    if (d.now() - startedAt > DISPATCH_BUDGET_MS) break
    kids.sort((a, b) => a.special_index - b.special_index)
    const n = sizes.get(groupId) ?? kids[kids.length - 1].special_index
    groups++
    units += kids.length
    try {
      await d.dispatchGroup(groupId, kids.map(k => k.id), n, startedAt)
    } catch (e) {
      console.error("[bundles] special continue: group dispatch failed:", groupId, e instanceof Error ? e.message : String(e))
    }
  }
  return { groups, units, skippedLedger: withLedger.size }
}

export function buildSpecialContinueDeps(db: SupabaseClient, bundles: BundlesDeps): SpecialContinueDeps {
  return {
    async listUnsent() {
      const { data, error } = await db.from(DATA_ORDERS_TABLE)
        .select("id, special_group_id, special_index")
        .not("special_group_id", "is", null)
        .eq("payment_status", "paid")
        .eq("status", "pending")
        .is("hubtel_client_reference", null)
        .is("notes", null)
        .lt("updated_at", new Date(bundles.now() - SPECIAL_WATCH_AGE_MS).toISOString())
        .order("updated_at", { ascending: true })
        .limit(SPECIAL_CONTINUE_LIMIT)
      if (error) throw error
      return (data ?? []) as UnsentChild[]
    },
    ledgerOrderIds: ids => fetchLedgerOrderIds(db, ids),
    groupSizes: groupIds => fetchSpecialGroupSizes(db, groupIds),
    dispatchGroup: (groupId, ids, n, startedAt) => dispatchSpecialGroup(bundles, groupId, ids, n, startedAt),
    now: () => bundles.now(),
  }
}
