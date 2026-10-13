import type { SupabaseClient } from "@supabase/supabase-js"
import type { OrderAdapter } from "../adapters"
import type { HubtelCsTx } from "../types"

export const BILL_ORDERS_TABLE = "hubtel_bill_orders"

/** The only statuses a Hubtel outcome may overwrite. 'completed', 'failed' and 'refunded' are never touched. */
const LIVE_STATUSES = ["pending", "processing"]

export interface BillOrderRow {
  status: string
  payment_status: string
  user_id: string
  biller: string
  amount: number
  account_number: string
}

export interface BillOrdersAdapterDeps {
  /** Current order (null if missing). Throws on DB error (the sweep retries). */
  get(orderId: string): Promise<BillOrderRow | null>
  /** Status-guarded write; returns rows changed (0 = guard did not match). Throws on DB error. */
  update(orderId: string, patch: Record<string, unknown>, onlyFromStatuses: string[]): Promise<number>
  /** Idempotent by referenceId. Throws on error. */
  creditWallet(userId: string, amount: number, referenceId: string, description: string): Promise<void>
  /** Best-effort customer notification (in-app + push). */
  notify(userId: string, title: string, message: string, orderId: string): Promise<void>
  /** Best-effort admin alert. */
  alertAdmin(message: string): Promise<void>
}

export function createBillOrdersAdapter(deps: BillOrdersAdapterDeps): OrderAdapter {
  const quiet = async (label: string, fn: () => Promise<void>) => {
    try { await fn() } catch (e: any) { console.error(`[hubtel-cs] bill ${label} error:`, e?.message ?? e) }
  }
  const summary = (o: BillOrderRow) => `${o.biller} GHS ${Number(o.amount).toFixed(2)} to ${o.account_number}`
  /** Reads the order for the message; any failure is swallowed (notifications are best-effort). */
  const notifyCustomer = async (orderId: string, title: string, text: (o: BillOrderRow) => string) => {
    await quiet(`notify "${title}"`, async () => {
      const o = await deps.get(orderId)
      if (o) await deps.notify(o.user_id, title, text(o), orderId)
    })
  }

  return {
    table: BILL_ORDERS_TABLE,

    async onFulfilled(tx: HubtelCsTx) {
      const id = tx.order_id!
      const n = await deps.update(id, {
        status: "completed",
        commission: tx.commission,
        notes: `Delivered via Hubtel [hcsRef:${tx.client_reference}]${tx.hubtel_transaction_id ? ` [txn:${tx.hubtel_transaction_id}]` : ""}`,
      }, LIVE_STATUSES)
      if (n > 0) {
        await notifyCustomer(id, "Bill paid", o => `${summary(o)} was delivered.`)
        return
      }
      await quiet("double-value check", async () => {
        const o = await deps.get(id)
        if (o && (o.status === "failed" || o.status === "refunded")) {
          await deps.alertAdmin(`Bill ${tx.client_reference} was delivered by Hubtel after being marked failed/refunded - check for double value (order ${id})`)
        }
      })
    },

    async onFailed(tx: HubtelCsTx) {
      const id = tx.order_id!
      const n = await deps.update(id, { status: "failed", failure_reason: tx.failure_reason ?? tx.response_code ?? "unknown reason" }, LIVE_STATUSES)
      if (n > 0) {
        await notifyCustomer(id, "Bill payment failed", o => `${summary(o)} is under review; a refund follows if it was not delivered.`)
      }
    },

    async refundToWallet(tx: HubtelCsTx, _adminId: string) {
      const id = tx.order_id!
      const o = await deps.get(id)
      if (!o) return { refunded: false, message: "Order not found" }
      // Already refunded by an earlier run: the credit exists, so the claim must NOT be released.
      if (o.status === "refunded" && o.payment_status === "refunded") {
        return { refunded: true, message: "Order was already refunded to the wallet" }
      }
      if (o.status !== "failed" || o.payment_status !== "paid") {
        return { refunded: false, message: "Order is not a paid failed order" }
      }
      // Credit first (idempotent by reference), then flip the status.
      await deps.creditWallet(o.user_id, Number(o.amount), `bill-refund-${id}`, `Refund: ${o.biller} bill ${tx.client_reference}`)
      const n = await deps.update(id, { status: "refunded", payment_status: "refunded" }, ["failed"])
      await notifyCustomer(id, "Bill refunded", x => `GHS ${Number(x.amount).toFixed(2)} for ${x.biller} to ${x.account_number} was refunded to your wallet.`)
      return {
        refunded: true,
        message: n > 0
          ? "Refunded to the customer's wallet"
          : "Refunded to the customer's wallet (order status update was skipped: order was no longer in failed state)",
      }
    },
  }
}

export function billOrdersAdapterFor(db: SupabaseClient): OrderAdapter {
  return createBillOrdersAdapter({
    async get(orderId) {
      const { data, error } = await db.from(BILL_ORDERS_TABLE)
        .select("status, payment_status, user_id, biller, amount, account_number").eq("id", orderId).maybeSingle()
      if (error) throw error
      return data ? (data as unknown as BillOrderRow) : null
    },
    async update(orderId, patch, onlyFromStatuses) {
      const { data, error } = await db.from(BILL_ORDERS_TABLE)
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", orderId).in("status", onlyFromStatuses).select("id")
      if (error) throw error
      return data?.length ?? 0
    },
    async creditWallet(userId, amount, referenceId, description) {
      const { error } = await db.rpc("credit_wallet_safely", {
        p_user_id: userId, p_amount: amount, p_reference_id: referenceId, p_description: description, p_source: "bill_refund",
      })
      if (error) throw error
    },
    async notify(userId, title, message, orderId) {
      try {
        const { error } = await db.from("notifications").insert({
          user_id: userId, title, message, type: "order_update", reference_id: orderId, action_url: "/dashboard/bills", read: false,
        })
        if (error) console.error("[hubtel-cs] bill notification insert error:", error.message)
      } catch (e: any) { console.error("[hubtel-cs] bill notification error:", e?.message ?? e) }
      try {
        const { sendPushToUser } = await import("@/lib/push-service")
        await sendPushToUser(userId, { title, body: message, data: { url: "/dashboard/bills" } })
      } catch (e: any) { console.error("[hubtel-cs] bill push error:", e?.message ?? e) }
    },
    async alertAdmin(message) {
      const { notifyAdmins } = await import("@/lib/sms-service")
      await notifyAdmins(message, "bills_review", undefined, true)
    },
  })
}
