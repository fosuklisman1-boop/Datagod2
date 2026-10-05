import type { SupabaseClient } from "@supabase/supabase-js"
import { sendSMS } from "@/lib/sms-service"
import { isWalletOnlyTable, type RefundableOrder } from "./types"

export interface RefundNotification {
  refundId: string
  order: RefundableOrder
  amount: number
  gateway: string
  clawbacks: { shop_id: string; owner_user_id: string | null; from_profit: number; from_wallet: number; credited: number }[]
}

/** The paying account's phone; null when unknown or the lookup fails (the SMS is then skipped, never redirected). */
async function accountPhone(db: SupabaseClient, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null
  try {
    const { data, error } = await db.from("users").select("phone_number").eq("id", userId).maybeSingle()
    if (error) {
      console.error("[REFUND] account phone lookup failed:", error.message)
      return null
    }
    const phone = (data as { phone_number?: string | null } | null)?.phone_number
    return phone ? String(phone) : null
  } catch (err) {
    console.error("[REFUND] account phone lookup threw:", err instanceof Error ? err.message : err)
    return null
  }
}

/** Customer SMS + in-app notice to each affected owner. Callers treat failures as non-fatal. */
export async function notifyRefund(db: SupabaseClient, e: RefundNotification): Promise<void> {
  const walletOnly = isWalletOnlyTable(e.order.table)
  // orders/api_orders: the buyer is the ACCOUNT HOLDER; the data recipient is a third party and is never told.
  const phone = walletOnly ? await accountPhone(db, e.order.buyerUserId) : (e.order.payment.payerPhone ?? e.order.recipientPhone)
  if (phone) {
    try {
      await sendSMS({
        phone,
        message: `Your order of ${e.order.packageLabel} ${e.order.network} could not be completed. GHS ${e.amount.toFixed(2)} has been refunded to you.`,
        type: "order_refund",
        reference: e.order.id,
      })
    } catch (err) {
      console.error("[REFUND] customer SMS failed (owner notifications continue):", err instanceof Error ? err.message : err)
    }
  }
  if (walletOnly && e.order.buyerUserId) {
    const { error } = await db.from("notifications").insert({
      user_id: e.order.buyerUserId,
      title: "Order refunded",
      message: `Your order of ${e.order.packageLabel} ${e.order.network} was refunded: GHS ${e.amount.toFixed(2)} credited to your wallet.`,
      type: "balance_updated",
      read: false,
      reference_id: e.order.id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    if (error) console.error("[REFUND] buyer notification failed:", error.message)
  }
  for (const line of e.clawbacks) {
    if (!line.owner_user_id || Number(line.credited) <= 0) continue
    const { error } = await db.from("notifications").insert({
      user_id: line.owner_user_id,
      title: "Order refunded",
      message: `An order was refunded to the customer. GHS ${Number(line.credited).toFixed(2)} was removed from your earnings${Number(line.from_wallet) > 0 ? ` (GHS ${Number(line.from_wallet).toFixed(2)} from your wallet)` : ""}.`,
      type: "balance_updated",
      read: false,
      reference_id: e.order.id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    if (error) console.error("[REFUND] owner notification failed:", error.message)
  }
}
