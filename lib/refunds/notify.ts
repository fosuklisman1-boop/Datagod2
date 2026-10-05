import type { SupabaseClient } from "@supabase/supabase-js"
import { sendSMS } from "@/lib/sms-service"
import type { RefundableOrder } from "./types"

export interface RefundNotification {
  refundId: string
  order: RefundableOrder
  amount: number
  gateway: string
  clawbacks: { shop_id: string; owner_user_id: string | null; from_profit: number; from_wallet: number; credited: number }[]
}

/** Customer SMS + in-app notice to each affected owner. Callers treat failures as non-fatal. */
export async function notifyRefund(db: SupabaseClient, e: RefundNotification): Promise<void> {
  const phone = e.order.payment.payerPhone ?? e.order.recipientPhone
  if (phone) {
    await sendSMS({
      phone,
      message: `Your order of ${e.order.packageLabel} ${e.order.network} could not be completed. GHS ${e.amount.toFixed(2)} has been refunded to you.`,
      type: "order_refund",
      reference: e.order.id,
    })
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
