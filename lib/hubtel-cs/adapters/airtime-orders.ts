import type { SupabaseClient } from "@supabase/supabase-js"
import type { OrderAdapter } from "../adapters"
import type { HubtelCsTx } from "../types"

export const AIRTIME_ORDERS_TABLE = "airtime_orders"

/** The only statuses a Hubtel outcome may overwrite. 'failed' (admin-refunded) and 'completed' are never touched. */
const LIVE_STATUSES = ["pending", "processing"]

export interface AirtimeOrdersAdapterDeps {
  /**
   * Status-guarded write: applies only while the order's status is in onlyFromStatuses.
   * Returns the number of rows changed (0 = guard did not match). Throws on DB error (the sweep retries).
   */
  update(orderId: string, patch: { status: string; notes: string }, onlyFromStatuses: string[]): Promise<number>
  getStatus(orderId: string): Promise<string | null>
  alert(message: string): Promise<void>
}

export function createAirtimeOrdersAdapter(deps: AirtimeOrdersAdapterDeps): OrderAdapter {
  const quietAlert = async (message: string) => {
    try { await deps.alert(message) } catch (e: any) { console.error("[hubtel-cs] airtime alert error:", e?.message ?? e) }
  }
  return {
    table: AIRTIME_ORDERS_TABLE,
    async onFulfilled(tx: HubtelCsTx) {
      const n = await deps.update(tx.order_id!, {
        status: "completed",
        notes: `Delivered via Hubtel [hcsRef:${tx.client_reference}]${tx.hubtel_transaction_id ? ` [txn:${tx.hubtel_transaction_id}]` : ""}`,
      }, LIVE_STATUSES)
      if (n === 0 && (await deps.getStatus(tx.order_id!)) === "failed") {
        await quietAlert(`Airtime ${tx.order_id} was delivered by Hubtel after being marked failed/refunded - check for double value (ref ${tx.client_reference})`)
      }
    },
    async onFailed(tx: HubtelCsTx) {
      // Same convention as the Digiwapy webhook: a provider failure returns the order to pending for an admin.
      const n = await deps.update(tx.order_id!, {
        status: "pending",
        notes: `Hubtel failed: ${tx.failure_reason ?? tx.response_code ?? "unknown reason"} [hcsRef:${tx.client_reference}]. Fulfil manually; not resent.`,
      }, LIVE_STATUSES)
      if (n === 0) {
        console.info(`[hubtel-cs] airtime order ${tx.order_id} already settled/failed; Hubtel failure not applied`)
        return
      }
      await quietAlert(`Airtime order ${tx.order_id} failed on Hubtel (${tx.failure_reason ?? tx.response_code ?? "?"}); needs manual fulfilment`)
    },
  }
}

export function airtimeOrdersAdapterFor(db: SupabaseClient): OrderAdapter {
  return createAirtimeOrdersAdapter({
    async update(orderId, patch, onlyFromStatuses) {
      const { data, error } = await db.from(AIRTIME_ORDERS_TABLE)
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", orderId).in("status", onlyFromStatuses).select("id")
      if (error) throw error
      return data?.length ?? 0
    },
    async getStatus(orderId) {
      const { data, error } = await db.from(AIRTIME_ORDERS_TABLE).select("status").eq("id", orderId).maybeSingle()
      if (error) throw error
      return data?.status ?? null
    },
    async alert(message) {
      const { notifyAdmins } = await import("@/lib/sms-service")
      await notifyAdmins(message, "airtime_manual_needed", undefined, true)
    },
  })
}
