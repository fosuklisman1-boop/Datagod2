// Per-row apply step for the Kuntanii status-sync cron. Lives here (not in the
// route) because Next rejects non-route exports from route files, and so it can
// be unit-tested with a fake db.
//
// Idempotent under overlapping cron runs / a concurrent webhook sync: the
// tracking update is guarded on the status this run read, so only the run that
// actually moves the row mirrors to the order table and notifies the user.

import { sendPushToUser } from "@/lib/push-service"

export type KuntaniiSyncRow = {
  id: string
  mtn_order_id: string
  status: string
  shop_order_id: string | null
  order_id: string | null
  api_order_id: string | null
  order_type: string | null
  size_gb: number | null
}

export type KuntaniiStatusResult = { success?: boolean; status?: string; message?: string; order?: { status?: string } | null }

export interface KuntaniiSyncDeps {
  push?: (userId: string, payload: { title: string; body: string }) => Promise<unknown>
}

/** Returns true when this call moved the tracking row (and mirrored + notified); false when another run got there first. */
export async function applyKuntaniiStatusChange(
  db: any,
  order: KuntaniiSyncRow,
  newStatus: string,
  result: KuntaniiStatusResult,
  deps: KuntaniiSyncDeps = {},
): Promise<boolean> {
  const push = deps.push ?? sendPushToUser
  const oldStatus = order.status

  const { data: moved, error } = await db
    .from("mtn_fulfillment_tracking")
    .update({
      status: newStatus,
      external_status: result.order?.status || newStatus,
      external_message: result.message,
      updated_at: new Date().toISOString(),
    })
    .eq("id", order.id)
    .eq("status", oldStatus)
    .select("id")
  if (error) throw new Error(`tracking update failed for ${order.id}: ${error.message}`)
  if (!moved || moved.length === 0) return false

  const orderTableStatus = newStatus === "failed" ? "pending" : newStatus
  let userId: string | null = null

  if (order.order_type === "bulk" && order.order_id) {
    const { data } = await db
      .from("orders")
      .update({ status: orderTableStatus, updated_at: new Date().toISOString() })
      .eq("id", order.order_id)
      .select("user_id")
      .single()
    userId = data?.user_id ?? null
  } else if (order.order_type === "api" && (order.api_order_id || order.order_id)) {
    const { data } = await db
      .from("api_orders")
      .update({ status: orderTableStatus, updated_at: new Date().toISOString() })
      .eq("id", order.api_order_id || order.order_id)
      .select("user_id")
      .single()
    userId = data?.user_id ?? null
  } else if (order.order_type === "ussd" && order.order_id) {
    await db
      .from("ussd_orders")
      .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
      .eq("id", order.order_id)
  } else if (order.order_type === "ussd_shop" && order.order_id) {
    await db
      .from("ussd_shop_orders")
      .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
      .eq("id", order.order_id)
  } else if (order.shop_order_id) {
    const { data: shopData } = await db
      .from("shop_orders")
      .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
      .eq("id", order.shop_order_id)
      .select("shop_id")
      .single()
    if (shopData?.shop_id) {
      const { data: owner } = await db.from("user_shops").select("user_id").eq("id", shopData.shop_id).single()
      userId = owner?.user_id ?? null
    }
  }

  if (userId && (newStatus === "completed" || newStatus === "failed")) {
    const title = newStatus === "completed" ? "Order Delivered Successfully" : "Order Delivery Failed"
    // No recipient phone in the message: keep PII out of notification text.
    const body = newStatus === "completed"
      ? `Your ${order.size_gb ?? ""}GB data order has been delivered successfully.`
      : `Your ${order.size_gb ?? ""}GB data order failed. Please contact support.`
    await db.from("notifications").insert({
      user_id: userId,
      title,
      message: body,
      type: newStatus === "completed" ? "order_completed" : "order_failed",
      reference_id: order.api_order_id || order.order_id || order.shop_order_id,
      read: false,
    })
    push(userId, { title, body }).catch(() => {})
  }

  return true
}
