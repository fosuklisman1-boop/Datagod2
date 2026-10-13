import type { HubtelCsTx } from "./types"

export interface OrderAdapter {
  /** The `order_table` value this adapter owns (e.g. "airtime_orders"). */
  table: string
  /** Called when a linked ledger row enters `fulfilled`. MUST be idempotent. */
  onFulfilled(tx: HubtelCsTx): Promise<void>
  /** Called when a linked ledger row enters `failed`. MUST be idempotent. Never auto-refunds. */
  onFailed(tx: HubtelCsTx): Promise<void>
  /**
   * Manual refund, only invoked from the admin review queue after an atomic claim on the ledger row.
   * MUST be idempotent per order (key it by tx.order_table + tx.order_id) because a thrown error keeps
   * the claim and an admin may re-check the wallet and retry via other means. MUST return
   * `refunded: false` ONLY when nothing was credited (that releases the claim); throw if unsure.
   */
  refundToWallet?(tx: HubtelCsTx, adminId: string): Promise<{ refunded: boolean; message: string }>
}

const registry = new Map<string, OrderAdapter>()

export function registerOrderAdapter(a: OrderAdapter): void { registry.set(a.table, a) }
export function getOrderAdapter(table: string | null): OrderAdapter | undefined { return table ? registry.get(table) : undefined }
export function clearOrderAdapters(): void { registry.clear() }

/** Route a terminal ledger row to its product. A failing hook must never break a callback or cron. */
export async function notifyAdapter(tx: HubtelCsTx): Promise<void> {
  if (!tx.order_table || !tx.order_id) return
  const adapter = registry.get(tx.order_table)
  if (!adapter) return
  try {
    if (tx.state === "fulfilled") await adapter.onFulfilled(tx)
    else if (tx.state === "failed") await adapter.onFailed(tx)
  } catch (e: any) {
    console.error(`[hubtel-cs] order adapter ${tx.order_table} hook failed for ${tx.client_reference}:`, e?.message ?? e)
  }
}
