// lib/payments/closed-order.ts
// A payment that lands on a storefront data order after the order was closed delivers nothing: fulfilment only claims
// `pending` orders. So it must not flip payment_status or credit shop profit. The wallet_payments row stays completed:
// that is the proof the money landed, and what lets /admin/refunds return it (migration 0154).
import type { SupabaseClient } from "@supabase/supabase-js"
import { sendThrottledAlert } from "@/lib/hubtel-pay/alert-throttle"

/** Order statuses no fulfilment will pick up, and which a late payment can land on. */
export const CLOSED_SHOP_ORDER_STATUSES: readonly string[] = ["expired", "failed", "cancelled", "canceled", "abandoned"]

/** A refund already ran or is running: closed too, but never refundable again. */
const ALREADY_REFUNDING = ["refunding", "refunded"]

/**
 * Closed, and this money was not recorded on it. payment_status 'completed' means the order was paid before it closed
 * (say a fulfilment that failed): a repeat event for that stays exactly as it was.
 */
export function isClosedUnpaidShopOrder(o: { order_status?: unknown; payment_status?: unknown } | null | undefined): boolean {
  if (!o || o.payment_status === "completed") return false
  const status = String(o.order_status ?? "")
  return CLOSED_SHOP_ORDER_STATUSES.includes(status) || ALREADY_REFUNDING.includes(status)
}

/** A closed order holding a completed payment it never recorded: what the refund tool may return. Mirrors 0154. */
export function isLatePaidShopOrder(o: { order_status?: unknown; payment_status?: unknown }, hasCompletedPayment: boolean): boolean {
  return hasCompletedPayment && o.payment_status !== "completed" && CLOSED_SHOP_ORDER_STATUSES.includes(String(o.order_status ?? ""))
}

/** Long enough to count as once: a payment's repeat deliveries and verifies happen within days. */
const ONCE_MS = 30 * 24 * 3_600_000

/** Tell admins once per payment. Ids only: no phone number. Never throws. */
export async function alertClosedOrderPayment(
  db: SupabaseClient,
  p: { orderId: string; reference: string; amountGhs: number },
  deps: { notify?: (message: string, type: string) => Promise<void>; now?: () => Date } = {},
): Promise<void> {
  try {
    await sendThrottledAlert(
      db,
      `A payment of GHS ${p.amountGhs.toFixed(2)} landed on closed order ${p.orderId} (ref ${p.reference}). Nothing was delivered. Refund it on /admin/refunds.`,
      {
        key: `closed_order_payment_alert:${p.reference}`,
        type: "closed_order_payment",
        description: "Late payment on a closed order: alert sent",
        windowMs: ONCE_MS,
        logPrefix: "[CLOSED-ORDER]",
        ...deps,
      },
    )
  } catch (e) {
    console.error("[CLOSED-ORDER] alert failed:", e instanceof Error ? e.name : "unknown")
  }
}
