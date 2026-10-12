import { notifyUserOfOutcome } from "@/lib/admin-actions"

/** Minimal row shape needed to tell a shop owner their withdrawal was paid out. */
export interface CompletedWithdrawalRow {
  id: string
  shop_id: string | null
  amount: number | string
  withdrawal_method?: string | null
  account_details?: unknown
}

/** Structural subset of a Supabase client (service role), so tests can fake it. */
type Db = { from(table: string): any }

/**
 * Tell the shop owner their withdrawal was paid out (flow: withdrawal/completed).
 * Call ONLY when this call actually moved the row into "completed". Never throws; await it.
 */
export async function notifyWithdrawalCompleted(db: Db, row: CompletedWithdrawalRow): Promise<void> {
  try {
    if (!row?.id || !row.shop_id) return
    const { data: shop } = await db.from("user_shops").select("user_id, shop_name").eq("id", row.shop_id).single()
    if (!shop?.user_id) return
    const { data: bal } = await db.from("shop_available_balance").select("available_balance").eq("shop_id", row.shop_id).single()
    const details = (row.account_details ?? {}) as { phone?: string; account_number?: string; network?: string }
    await notifyUserOfOutcome("withdrawal", "completed", { userId: shop.user_id, reference: row.id }, {
      withdrawalId: row.id,
      amount: Number(row.amount),
      shopName: shop.shop_name ?? null,
      method: row.withdrawal_method || details.network || null,
      phone: details.phone || details.account_number || null,
      remainingBalance: bal?.available_balance != null ? Number(bal.available_balance).toFixed(2) : null,
    })
  } catch (err) {
    console.warn("[ADMIN-ACTION] withdrawal completed notify failed:", err instanceof Error ? err.message : err)
  }
}

/**
 * Apply a provider-confirmed "completed" write and say whether the owner should be told.
 *
 * The write is conditional on the row still being in one of `fromStatuses` (so a webhook/cron/other
 * run that already completed it wins and we stay silent). When it matches 0 rows with no error we
 * re-read: if the row is NOT completed (e.g. an admin reset a processing row back to pending while
 * the transfer actually went out) the provider confirmation is authoritative, so we apply the old
 * unconditional write, log CRITICAL, and notify. A DB error on the conditional write notifies
 * (money moved) without a second write. Never throws.
 */
export async function applyWithdrawalCompletion(
  db: Db,
  withdrawalId: string,
  fields: Record<string, unknown>,
  fromStatuses: string[],
): Promise<{ shouldNotify: boolean; error?: unknown }> {
  const completed = { ...fields, status: "completed" }
  try {
    const { data, error } = await db
      .from("withdrawal_requests")
      .update(completed)
      .eq("id", withdrawalId)
      .in("status", fromStatuses)
      .select("id")
    if (error) return { shouldNotify: true, error }
    if (data && data.length > 0) return { shouldNotify: true }

    const { data: cur, error: readErr } = await db.from("withdrawal_requests").select("status").eq("id", withdrawalId).maybeSingle()
    if (readErr || !cur || cur.status === "completed") return { shouldNotify: false }

    console.error(`[WITHDRAWAL] CRITICAL: provider-confirmed completion applied over status=${cur.status} for ${withdrawalId}`)
    const { error: forceErr } = await db.from("withdrawal_requests").update(completed).eq("id", withdrawalId)
    return { shouldNotify: true, error: forceErr ?? undefined }
  } catch (err) {
    console.warn("[WITHDRAWAL] completion write threw:", err instanceof Error ? err.message : err)
    return { shouldNotify: false, error: err }
  }
}
