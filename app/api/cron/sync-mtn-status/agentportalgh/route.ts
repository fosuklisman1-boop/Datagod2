import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { checkMTNOrderStatus } from "@/lib/mtn-fulfillment"
import { verifyCronAuth } from "@/lib/cron-auth"
import { sendPushToUser } from "@/lib/push-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const BATCH_SIZE = 50
const DELAY_BETWEEN_REQUESTS_MS = 1000
// AgentPortalGH's queue auto-retries a failed item internally up to 3x (§8),
// often as a separate webhook delivery per attempt — a "failed" row here isn't
// necessarily final. Keep re-checking recent ones so a later real success gets
// caught even if the correcting webhook never arrives.
const RECHECK_FAILED_WINDOW_H = 24

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * GET /api/cron/sync-mtn-status/agentportalgh
 *
 * Polling fallback for AgentPortalGH orders whose webhook was missed.
 * Calls checkOrderStatus (two-pass: queue scan + completed orders search)
 * for each pending/processing order and updates mtn_fulfillment_tracking +
 * the originating order table. Runs every 5 minutes via Vercel Cron.
 */
export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized && errorResponse) return errorResponse

  console.log("[CRON-AGENTPORTALGH] Starting status sync...")

  const failedCutoffIso = new Date(Date.now() - RECHECK_FAILED_WINDOW_H * 60 * 60 * 1000).toISOString()

  const [{ data: active, error: activeErr }, { data: recentFailed, error: failedErr }] = await Promise.all([
    supabase
      .from("mtn_fulfillment_tracking")
      .select("id, mtn_order_id, status, shop_order_id, order_id, api_order_id, order_type, created_at")
      .eq("provider", "agentportalgh")
      .in("status", ["pending", "processing"])
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE),
    supabase
      .from("mtn_fulfillment_tracking")
      .select("id, mtn_order_id, status, shop_order_id, order_id, api_order_id, order_type, created_at")
      .eq("provider", "agentportalgh")
      .eq("status", "failed")
      .gte("created_at", failedCutoffIso)
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE),
  ])

  if (activeErr || failedErr) {
    console.error("[CRON-AGENTPORTALGH] Error fetching orders:", activeErr || failedErr)
    return NextResponse.json({ error: "Failed to fetch orders" }, { status: 500 })
  }

  const pendingOrders = [...(active ?? []), ...(recentFailed ?? [])]
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(0, BATCH_SIZE)

  if (!pendingOrders || pendingOrders.length === 0) {
    return NextResponse.json({ success: true, message: "No AgentPortalGH orders to sync" })
  }

  console.log(`[CRON-AGENTPORTALGH] Found ${pendingOrders.length} orders to sync`)

  let synced = 0
  let failed = 0
  const results = []

  for (let i = 0; i < pendingOrders.length; i++) {
    const order = pendingOrders[i]

    try {
      console.log(`[CRON-AGENTPORTALGH] Syncing ${i + 1}/${pendingOrders.length}: ${order.mtn_order_id}`)

      const result = await checkMTNOrderStatus(order.mtn_order_id, "agentportalgh")

      if (result.success && result.status) {
        const oldStatus = order.status
        const newStatus = result.status
        const statusPriority: Record<string, number> = { pending: 1, processing: 2, completed: 3, failed: 3 }

        if ((statusPriority[newStatus] ?? 0) < (statusPriority[oldStatus] ?? 0)) {
          console.log(`[CRON-AGENTPORTALGH] Skipping regression ${oldStatus} -> ${newStatus} for ${order.mtn_order_id}`)
          results.push({ id: order.id, mtn_order_id: order.mtn_order_id, success: true, status: oldStatus, skipped: true })
          continue
        }

        if (newStatus !== oldStatus) {
          await supabase
            .from("mtn_fulfillment_tracking")
            .update({
              status: newStatus,
              external_status: result.order?.status || newStatus,
              external_message: result.message,
              updated_at: new Date().toISOString(),
            })
            .eq("id", order.id)

          const orderTableStatus = newStatus === "failed" ? "pending" : newStatus
          let userId: string | null = null
          let orderDetails: { network?: string; size?: string; phone?: string } = {}

          if (order.order_type === "bulk" && order.order_id) {
            const { data: o } = await supabase
              .from("orders")
              .update({ status: orderTableStatus, updated_at: new Date().toISOString() })
              .eq("id", order.order_id)
              .select("user_id, network, size, phone_number")
              .single()
            if (o) { userId = o.user_id; orderDetails = { network: o.network, size: o.size, phone: o.phone_number } }
          } else if (order.order_type === "api" && (order.api_order_id || order.order_id)) {
            const apiId = order.api_order_id || order.order_id
            const { data: o } = await supabase
              .from("api_orders")
              .update({ status: orderTableStatus, updated_at: new Date().toISOString() })
              .eq("id", apiId)
              .select("user_id, network, volume_gb, recipient_phone")
              .single()
            if (o) { userId = o.user_id; orderDetails = { network: o.network, size: `${o.volume_gb}GB`, phone: o.recipient_phone } }
          } else if (order.order_type === "ussd" && order.order_id) {
            const { data: o } = await supabase
              .from("ussd_orders")
              .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
              .eq("id", order.order_id)
              .select("network, package_size, recipient_phone")
              .single()
            if (o) { orderDetails = { network: o.network, size: o.package_size, phone: o.recipient_phone } }
          } else if (order.order_type === "ussd_shop" && order.order_id) {
            const { data: o } = await supabase
              .from("ussd_shop_orders")
              .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
              .eq("id", order.order_id)
              .select("network, package_size, recipient_phone")
              .single()
            if (o) { orderDetails = { network: o.network, size: o.package_size, phone: o.recipient_phone } }
          } else if (order.shop_order_id) {
            const { data: o } = await supabase
              .from("shop_orders")
              .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
              .eq("id", order.shop_order_id)
              .select("shop_id, network, volume_gb, customer_phone")
              .single()
            if (o) {
              orderDetails = { network: o.network, size: `${o.volume_gb}GB`, phone: o.customer_phone }
              const { data: shopOwner } = await supabase.from("user_shops").select("user_id").eq("id", o.shop_id).single()
              userId = shopOwner?.user_id ?? null
            }
          }

          if (userId && (newStatus === "completed" || newStatus === "failed")) {
            const title = newStatus === "completed" ? "Order Delivered Successfully" : "Order Delivery Failed"
            const body = newStatus === "completed"
              ? `Your ${orderDetails.size ?? ""} ${orderDetails.network ?? "MTN"} bundle for ${orderDetails.phone ?? "your number"} was delivered.`
              : `Your ${orderDetails.size ?? ""} ${orderDetails.network ?? "MTN"} bundle for ${orderDetails.phone ?? "your number"} could not be delivered. We will retry.`
            sendPushToUser(userId, { title, body }).catch(() => null)
          }

          synced++
        }

        results.push({ id: order.id, mtn_order_id: order.mtn_order_id, success: true, status: newStatus })
      } else {
        failed++
        results.push({ id: order.id, mtn_order_id: order.mtn_order_id, success: false, message: result.message })
      }
    } catch (err) {
      failed++
      console.error(`[CRON-AGENTPORTALGH] Error syncing ${order.mtn_order_id}:`, err)
      results.push({ id: order.id, mtn_order_id: order.mtn_order_id, success: false, message: String(err) })
    }

    if (i < pendingOrders.length - 1) await sleep(DELAY_BETWEEN_REQUESTS_MS)
  }

  return NextResponse.json({
    success: true,
    total: pendingOrders.length,
    synced,
    failed,
    results,
  })
}
