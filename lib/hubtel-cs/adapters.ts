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

/**
 * Adapters MUST be registered statically from lib/hubtel-cs/runtime.ts (imported by both the callback route
 * and the status cron) so they exist in EVERY serverless entry point. A route that settles a row without the
 * adapter registered would silently skip the order hook.
 */
const registry = new Map<string, OrderAdapter>()

export function registerOrderAdapter(a: OrderAdapter): void { registry.set(a.table, a) }
export function getOrderAdapter(table: string | null): OrderAdapter | undefined { return table ? registry.get(table) : undefined }
export function clearOrderAdapters(): void { registry.clear() }

export type NotifyResult = "synced" | "no_order" | "not_terminal" | "no_adapter" | "failed"

/** Route a terminal ledger row to its product. Never throws; the result says whether the order was updated. */
export async function notifyAdapter(tx: HubtelCsTx): Promise<NotifyResult> {
  if (!tx.order_table || !tx.order_id) return "no_order"
  if (tx.state !== "fulfilled" && tx.state !== "failed") return "not_terminal"
  const adapter = registry.get(tx.order_table)
  if (!adapter) {
    // The ledger row is terminal but its order will never be updated: this needs a human, so log loudly.
    console.error(`[hubtel-cs] no order adapter registered for order_table "${tx.order_table}" (ref ${tx.client_reference}, state ${tx.state}); order not updated`)
    return "no_adapter"
  }
  try {
    if (tx.state === "fulfilled") await adapter.onFulfilled(tx)
    else await adapter.onFailed(tx)
    return "synced"
  } catch (e: any) {
    console.error(`[hubtel-cs] order adapter ${tx.order_table} hook failed for ${tx.client_reference}:`, e?.message ?? e)
    return "failed"
  }
}
