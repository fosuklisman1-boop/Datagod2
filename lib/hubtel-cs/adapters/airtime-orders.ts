import type { SupabaseClient } from "@supabase/supabase-js"
import type { OrderAdapter } from "../adapters"
import type { HubtelCsTx } from "../types"

export const AIRTIME_ORDERS_TABLE = "airtime_orders"

export interface AirtimeOrdersAdapterDeps {
  /** Must be idempotent and must not downgrade a completed order. Throws on DB error (the sweep retries). */
  update(orderId: string, patch: { status: string; notes: string }): Promise<void>
  alert(message: string): Promise<void>
}

export function createAirtimeOrdersAdapter(deps: AirtimeOrdersAdapterDeps): OrderAdapter {
  return {
    table: AIRTIME_ORDERS_TABLE,
    async onFulfilled(tx: HubtelCsTx) {
      await deps.update(tx.order_id!, {
        status: "completed",
        notes: `Delivered via Hubtel [hcsRef:${tx.client_reference}]${tx.hubtel_transaction_id ? ` [txn:${tx.hubtel_transaction_id}]` : ""}`,
      })
    },
    async onFailed(tx: HubtelCsTx) {
      // Same convention as the Digiwapy webhook: a provider failure returns the order to pending for an admin.
      await deps.update(tx.order_id!, {
        status: "pending",
        notes: `Hubtel failed: ${tx.failure_reason ?? tx.response_code ?? "unknown reason"} [hcsRef:${tx.client_reference}]. Fulfil manually; not resent.`,
      })
      try { await deps.alert(`Airtime order ${tx.order_id} failed on Hubtel (${tx.failure_reason ?? tx.response_code ?? "?"}); needs manual fulfilment`) }
      catch (e: any) { console.error("[hubtel-cs] airtime failure alert error:", e?.message ?? e) }
    },
  }
}

export function airtimeOrdersAdapterFor(db: SupabaseClient): OrderAdapter {
  return createAirtimeOrdersAdapter({
    async update(orderId, patch) {
      const { error } = await db.from(AIRTIME_ORDERS_TABLE)
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", orderId).neq("status", "completed")
      if (error) throw error
    },
    async alert(message) {
      const { notifyAdmins } = await import("@/lib/sms-service")
      await notifyAdmins(message, "airtime_manual_needed", undefined, true)
    },
  })
}
