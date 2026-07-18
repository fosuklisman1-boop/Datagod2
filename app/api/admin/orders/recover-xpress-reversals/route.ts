import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { checkMTNOrderStatus } from "@/lib/mtn-fulfillment"
import { flagReversal, type ReversalRow } from "@/lib/mtn-reversal"

export const maxDuration = 300

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * POST /api/admin/orders/recover-xpress-reversals
 *
 * One-time recovery for Xpress orders that the pre-fix webhook handler
 * incorrectly set to "failed" (tracking) / "pending" (order table) when
 * Xpress flipped a completed order. For each failed Xpress tracking row
 * we ask Xpress directly: if they say "completed", it was a reversal and
 * we flag it; if they still say "failed", it was a genuine failure and
 * we leave it alone. Idempotent — safe to run multiple times.
 */
export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    // Fetch all Xpress tracking rows currently in "failed" state
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
      return NextResponse.json({ success: true, message: "No failed Xpress tracking rows found", total: 0, reversed: 0, genuine: 0, errors: 0 })
    }

    console.log(`[XPRESS-RECOVERY] Found ${candidates.length} failed Xpress tracking rows — checking with Xpress API`)

    const results: Array<{ mtn_order_id: string; action: string; message: string }> = []
    let reversed = 0
    let genuine = 0
    let errors = 0

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
          // Xpress confirms delivery — this was a false failure report; flag as reversed
          const reversalRow: ReversalRow = {
            id: row.id,
            order_type: row.order_type,
            order_id: row.order_id,
            shop_order_id: row.shop_order_id,
            api_order_id: row.api_order_id,
            provider: "xpress",
          }
          await flagReversal(supabase, reversalRow, { status: "failed", message: "Recovered by xpress-reversal recovery run" })
          results.push({ mtn_order_id: String(orderId), action: "reversed", message: "Xpress says completed — flagged as reversed" })
          reversed++
        } else {
          // Genuinely failed — leave it; the order stays in pending for manual re-fulfillment
          results.push({ mtn_order_id: String(orderId), action: "genuine_failure", message: `Xpress status: ${statusResult.status}` })
          genuine++
        }
      } catch (err: any) {
        results.push({ mtn_order_id: String(orderId), action: "error", message: err.message || "Unexpected error" })
        errors++
      }
    }

    console.log(`[XPRESS-RECOVERY] Done: ${reversed} reversed, ${genuine} genuine failures, ${errors} errors`)

    return NextResponse.json({
      success: true,
      total: candidates.length,
      reversed,
      genuine,
      errors,
      results,
    })
  } catch (err: any) {
    console.error("[XPRESS-RECOVERY] Unhandled error:", err)
    return NextResponse.json({ error: err.message || "Internal server error" }, { status: 500 })
  }
}
