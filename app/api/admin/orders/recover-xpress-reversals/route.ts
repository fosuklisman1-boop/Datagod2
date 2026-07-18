import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { checkMTNOrderStatus } from "@/lib/mtn-fulfillment"

export const maxDuration = 300

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

function orderTarget(row: {
  order_type: string | null
  order_id: string | null
  shop_order_id: string | null
  api_order_id: string | null
}): { table: string; col: "status" | "order_status"; id: string } | null {
  if (row.order_type === "bulk" && row.order_id)
    return { table: "orders", col: "status", id: row.order_id }
  if (row.order_type === "api" && (row.api_order_id || row.order_id))
    return { table: "api_orders", col: "status", id: (row.api_order_id || row.order_id)! }
  if (row.order_type === "ussd" && row.order_id)
    return { table: "ussd_orders", col: "order_status", id: row.order_id }
  if (row.order_type === "ussd_shop" && row.order_id)
    return { table: "ussd_shop_orders", col: "order_status", id: row.order_id }
  if (row.shop_order_id)
    return { table: "shop_orders", col: "order_status", id: row.shop_order_id }
  if (row.order_id) return { table: "orders", col: "status", id: row.order_id }
  if (row.api_order_id) return { table: "api_orders", col: "status", id: row.api_order_id }
  return null
}

async function applyStatus(rowId: string, row: Parameters<typeof orderTarget>[0], newTrackingStatus: string, newOrderStatus: string, note: string, nowIso: string) {
  await supabase
    .from("mtn_fulfillment_tracking")
    .update({ status: newTrackingStatus, external_message: note, updated_at: nowIso })
    .eq("id", rowId)

  const target = orderTarget(row)
  if (target) {
    await supabase
      .from(target.table)
      .update({ [target.col]: newOrderStatus, updated_at: nowIso })
      .eq("id", target.id)
  }
}

/**
 * POST /api/admin/orders/recover-xpress-reversals
 *
 * Full Xpress status sync — sweeps tracking rows in both "processing" and
 * "failed" state, checks each against the Xpress API, then applies the
 * correct status. Idempotent and safe to run multiple times.
 *
 * processing + Xpress says completed → mark completed   (delivered, no re-fulfil)
 * processing + Xpress says failed    → tracking=failed, order=pending  (re-queue)
 * processing + Xpress says pending   → no change        (still in flight)
 * failed     + Xpress says completed → restore completed (false webhook)
 * failed     + Xpress says failed    → no change        (genuine failure, stays pending)
 */
export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { data: candidates, error: fetchErr } = await supabase
      .from("mtn_fulfillment_tracking")
      .select("id, mtn_order_id, order_type, order_id, shop_order_id, api_order_id, provider, status, updated_at")
      .eq("provider", "xpress")
      .in("status", ["processing", "failed"])
      .order("updated_at", { ascending: false })
      .limit(300)

    if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 })

    if (!candidates || candidates.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No processing or failed Xpress rows found",
        total: 0, completed: 0, requeued: 0, restored: 0, genuine: 0, noChange: 0, errors: 0, results: [],
      })
    }

    console.log(`[XPRESS-SYNC] ${candidates.length} rows (processing+failed) — querying Xpress API`)

    type Action = "completed" | "requeued" | "restored" | "genuine_failure" | "no_change" | "skip" | "error"
    const results: Array<{ mtn_order_id: string; was: string; action: Action; message: string }> = []

    let completed = 0  // processing → completed (delivered)
    let requeued  = 0  // processing → failed → order back to pending
    let restored  = 0  // failed     → completed (false failure webhook)
    let genuine   = 0  // failed     → still failed (real failure)
    let noChange  = 0  // still in flight
    let errors    = 0

    const nowIso = new Date().toISOString()

    for (const row of candidates) {
      const orderId = row.mtn_order_id
      if (!orderId) {
        results.push({ mtn_order_id: "(none)", was: row.status, action: "skip", message: "No mtn_order_id" })
        errors++
        continue
      }

      try {
        const { success, status: xpressStatus, message } = await checkMTNOrderStatus(orderId, "xpress")

        if (!success) {
          results.push({ mtn_order_id: String(orderId), was: row.status, action: "error", message })
          errors++
          continue
        }

        if (row.status === "processing") {
          if (xpressStatus === "completed") {
            await applyStatus(row.id, row, "completed", "completed", "Marked completed by Xpress sync", nowIso)
            results.push({ mtn_order_id: String(orderId), was: "processing", action: "completed", message: "Xpress confirms delivery" })
            completed++
          } else if (xpressStatus === "failed") {
            // order table goes back to pending so it can be re-fulfilled
            await applyStatus(row.id, row, "failed", "pending", "Failed confirmed by Xpress sync — re-queued", nowIso)
            results.push({ mtn_order_id: String(orderId), was: "processing", action: "requeued", message: "Xpress says failed — order re-queued for fulfillment" })
            requeued++
          } else {
            // pending or still processing on Xpress side — leave it
            results.push({ mtn_order_id: String(orderId), was: "processing", action: "no_change", message: `Xpress still shows: ${xpressStatus}` })
            noChange++
          }
        } else {
          // row.status === "failed"
          if (xpressStatus === "completed") {
            await applyStatus(row.id, row, "completed", "completed", "Restored by Xpress sync (false failure webhook)", nowIso)
            results.push({ mtn_order_id: String(orderId), was: "failed", action: "restored", message: "Xpress confirms delivery — restored to completed" })
            restored++
          } else {
            // Xpress also says failed — genuine failure, order already in pending
            results.push({ mtn_order_id: String(orderId), was: "failed", action: "genuine_failure", message: `Xpress status: ${xpressStatus}` })
            genuine++
          }
        }
      } catch (err: any) {
        results.push({ mtn_order_id: String(orderId), was: row.status, action: "error", message: err.message || "Unexpected error" })
        errors++
      }
    }

    console.log(`[XPRESS-SYNC] completed=${completed} requeued=${requeued} restored=${restored} genuine=${genuine} noChange=${noChange} errors=${errors}`)

    return NextResponse.json({
      success: true,
      total: candidates.length,
      completed,
      requeued,
      restored,
      genuine,
      noChange,
      errors,
      results,
    })
  } catch (err: any) {
    console.error("[XPRESS-SYNC] Unhandled error:", err)
    return NextResponse.json({ error: err.message || "Internal server error" }, { status: 500 })
  }
}
