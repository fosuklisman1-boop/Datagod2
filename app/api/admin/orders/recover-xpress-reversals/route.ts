import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { checkMTNOrderStatus } from "@/lib/mtn-fulfillment"

export const maxDuration = 300

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/** Map a tracking row to its parent order table + column. */
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

/**
 * POST /api/admin/orders/recover-xpress-reversals
 *
 * Recovery for Xpress orders the pre-fix webhook incorrectly set to
 * "failed" (tracking) / "pending" (order table) when Xpress sent a failure
 * notice for an already-delivered order.
 *
 * For each failed Xpress tracking row we ask Xpress directly:
 *   - "completed" → Xpress confirms delivery; restore both tracking and
 *     order table to "completed". Data was delivered — no re-fulfillment needed.
 *   - anything else → genuine failure; leave as pending for manual re-fulfillment.
 *
 * Idempotent — safe to run multiple times.
 */
export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { data: candidates, error: fetchErr } = await supabase
      .from("mtn_fulfillment_tracking")
      .select("id, mtn_order_id, order_type, order_id, shop_order_id, api_order_id, provider, status, updated_at")
      .eq("provider", "xpress")
      .eq("status", "failed")
      .order("updated_at", { ascending: false })
      .limit(200)

    if (fetchErr) {
      return NextResponse.json({ error: fetchErr.message }, { status: 500 })
    }

    if (!candidates || candidates.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No failed Xpress tracking rows found",
        total: 0, restored: 0, genuine: 0, errors: 0, results: [],
      })
    }

    console.log(`[XPRESS-RECOVERY] ${candidates.length} failed Xpress rows — querying Xpress API`)

    const results: Array<{ mtn_order_id: string; action: string; message: string }> = []
    let restored = 0
    let genuine = 0
    let errors = 0
    const nowIso = new Date().toISOString()

    for (const row of candidates) {
      const orderId = row.mtn_order_id
      if (!orderId) {
        results.push({ mtn_order_id: "(none)", action: "skip", message: "No mtn_order_id" })
        errors++
        continue
      }

      try {
        const statusResult = await checkMTNOrderStatus(orderId, "xpress")

        if (!statusResult.success) {
          results.push({ mtn_order_id: String(orderId), action: "error", message: statusResult.message })
          errors++
          continue
        }

        if (statusResult.status === "completed") {
          // Xpress confirms delivery — restore to completed in both tracking and order table
          await supabase
            .from("mtn_fulfillment_tracking")
            .update({ status: "completed", external_message: "Restored by xpress-recovery run", updated_at: nowIso })
            .eq("id", row.id)

          const target = orderTarget(row)
          if (target) {
            await supabase
              .from(target.table)
              .update({ [target.col]: "completed", updated_at: nowIso })
              .eq("id", target.id)
          }

          results.push({ mtn_order_id: String(orderId), action: "restored", message: "Xpress confirms delivery — restored to completed" })
          restored++
        } else {
          // Genuinely failed — leave in pending for manual re-fulfillment
          results.push({ mtn_order_id: String(orderId), action: "genuine_failure", message: `Xpress status: ${statusResult.status}` })
          genuine++
        }
      } catch (err: any) {
        results.push({ mtn_order_id: String(orderId), action: "error", message: err.message || "Unexpected error" })
        errors++
      }
    }

    console.log(`[XPRESS-RECOVERY] Done: ${restored} restored, ${genuine} genuine failures, ${errors} errors`)

    return NextResponse.json({
      success: true,
      total: candidates.length,
      restored,
      genuine,
      errors,
      results,
    })
  } catch (err: any) {
    console.error("[XPRESS-RECOVERY] Unhandled error:", err)
    return NextResponse.json({ error: err.message || "Internal server error" }, { status: 500 })
  }
}
