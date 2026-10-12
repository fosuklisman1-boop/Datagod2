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
    const details = (row.account_details ?? {}) as { phone?: string; account_number?: string; network?: string }
    await notifyUserOfOutcome("withdrawal", "completed", { userId: shop.user_id, reference: row.id }, {
      withdrawalId: row.id,
      amount: Number(row.amount),
      shopName: shop.shop_name ?? null,
      method: row.withdrawal_method || details.network || null,
      phone: details.phone || details.account_number || null,
    })
  } catch (err) {
    console.warn("[ADMIN-ACTION] withdrawal completed notify failed:", err instanceof Error ? err.message : err)
  }
}
