import type { SupabaseClient } from "@supabase/supabase-js"
import type { OrderAdapter } from "../adapters"
import type { HubtelCsTx } from "../types"
import { BILLERS, isBillerKey } from "@/lib/bills/billers"

/** Display label for messages; unknown keys fall back to the raw value. */
const labelOf = (biller: string) => (isBillerKey(biller) ? BILLERS[biller].label : biller)

export const BILL_ORDERS_TABLE = "hubtel_bill_orders"

/** The only statuses a Hubtel outcome may overwrite. 'completed', 'failed' and 'refunded' are never touched. */
const LIVE_STATUSES = ["pending", "processing"]

export interface BillOrderRow {
  status: string
  payment_status: string
  /** NULL on storefront rows (anonymous buyer). */
  user_id: string | null
  /** 'dashboard' | 'storefront' | 'api'; absent on rows read before 0120. */
  channel?: string | null
  biller: string
  amount: number
  /** What the customer actually paid (cashback orders); null/absent on legacy rows. */
  paid_amount?: number | null
  account_number: string
}

/** The money to return to the customer: what they paid, falling back to the face amount on legacy rows. */
const refundAmount = (o: BillOrderRow) => Number(o.paid_amount ?? o.amount)

/** Shown when the review queue is asked to wallet-refund a storefront order (it has no wallet to credit). */
export const STOREFRONT_REFUND_MESSAGE =
  "Storefront order: the buyer has no wallet. Refund it on /admin/refunds (Paystack reversal, MoMo payout, or Mark refunded manually)."

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
  const summary = (o: BillOrderRow) => `${labelOf(o.biller)} GHS ${Number(o.amount).toFixed(2)} to ${o.account_number}`
  /** Reads the order for the message; any failure is swallowed (notifications are best-effort). */
  const notifyCustomer = async (orderId: string, title: string, text: (o: BillOrderRow) => string) => {
    await quiet(`notify "${title}"`, async () => {
      const o = await deps.get(orderId)
      if (o?.user_id) await deps.notify(o.user_id, title, text(o), orderId) // storefront buyers have no account to notify
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
      const n = await deps.update(id, { status: "failed", failure_reason: tx.failure_reason ?? tx.response_code ?? "unknown reason", notes: `Failed via Hubtel [hcsRef:${tx.client_reference}]` }, LIVE_STATUSES)
      if (n > 0) {
        await notifyCustomer(id, "Bill payment failed", o => `${summary(o)} is under review; a refund follows if it was not delivered.`)
      }
    },

    async refundToWallet(tx: HubtelCsTx, _adminId: string) {
      const id = tx.order_id!
      const o = await deps.get(id)
      if (!o) return { refunded: false, message: "Order not found" }
      // Never "refund" a storefront order to a NULL wallet; refunded:false releases the ledger claim.
      if (o.channel === "storefront" || !o.user_id) return { refunded: false, message: STOREFRONT_REFUND_MESSAGE }
      // Already refunded by an earlier run: the credit exists, so the claim must NOT be released.
      if (o.status === "refunded" && o.payment_status === "refunded") {
        return { refunded: true, message: "Order was already refunded to the wallet" }
      }
      if (o.status !== "failed" || o.payment_status !== "paid") {
        return { refunded: false, message: "Order is not a paid failed order" }
      }
      // Credit first (idempotent by reference), then flip the status.
      await deps.creditWallet(o.user_id, refundAmount(o), `bill-refund-${id}`, `Refund: ${labelOf(o.biller)} bill ${tx.client_reference}`)
      const n = await deps.update(id, { status: "refunded", payment_status: "refunded" }, ["failed"])
      await notifyCustomer(id, "Bill refunded", x => `GHS ${refundAmount(x).toFixed(2)} for ${labelOf(x.biller)} to ${x.account_number} was refunded to your wallet.`)
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
        .select("status, payment_status, user_id, channel, biller, amount, paid_amount, account_number").eq("id", orderId).maybeSingle()
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
