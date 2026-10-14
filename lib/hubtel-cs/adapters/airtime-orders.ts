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
  /** Current status + notes (null if the order is missing). Throws on DB error. */
  get(orderId: string): Promise<{ status: string; notes: string | null } | null>
  getStatus(orderId: string): Promise<string | null>
  alert(message: string): Promise<void>
}

/**
 * Deliberately no refundToWallet: the review queue cannot refund airtime (storefront airtime buyers have no wallet,
 * user_id NULL). Storefront airtime is refunded on /admin/refunds.
 */
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
      // 'refunding'/'refunded': a storefront order refunded through /admin/refunds.
      if (n === 0 && ["failed", "refunding", "refunded"].includes((await deps.getStatus(tx.order_id!)) ?? "")) {
        await quietAlert(`Airtime ${tx.order_id} was delivered by Hubtel after being marked failed/refunded - check for double value (ref ${tx.client_reference})`)
      }
    },
    async onFailed(tx: HubtelCsTx) {
      // Same convention as the Digiwapy webhook: a provider failure returns the order to pending for an admin.
      // A replayed onFailed must not clobber an order another provider/admin now owns (e.g. a manual Digiwapy retry).
      const cur = await deps.get(tx.order_id!)
      if (!cur || !LIVE_STATUSES.includes(cur.status)) {
        console.info(`[hubtel-cs] airtime order ${tx.order_id} already settled/failed; Hubtel failure not applied`)
        return
      }
      if (cur.status === "processing" && !(cur.notes ?? "").includes(`hcsRef:${tx.client_reference}`)) {
        console.info(`[hubtel-cs] airtime order ${tx.order_id} is processing under another provider; Hubtel failure not applied`)
        return
      }
      const n = await deps.update(tx.order_id!, {
        status: "pending",
        notes: `Hubtel failed: ${tx.failure_reason ?? tx.response_code ?? "unknown reason"} [hcsRef:${tx.client_reference}]. Fulfil manually; not resent.`,
      }, [cur.status])
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
    async get(orderId) {
      const { data, error } = await db.from(AIRTIME_ORDERS_TABLE).select("status, notes").eq("id", orderId).maybeSingle()
      if (error) throw error
      return data ? { status: data.status as string, notes: (data.notes as string | null) ?? null } : null
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
