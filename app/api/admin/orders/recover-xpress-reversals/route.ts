import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { checkMTNOrderStatus } from "@/lib/mtn-fulfillment"
import { notifyAdminsPush } from "@/lib/push-service"

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

async function setStatus(rowId: string, row: Parameters<typeof orderTarget>[0], trackingStatus: string, orderStatus: string, note: string, nowIso: string) {
  await supabase
    .from("mtn_fulfillment_tracking")
    .update({ status: trackingStatus, external_message: note, updated_at: nowIso })
    .eq("id", rowId)

  const target = orderTarget(row)
  if (target) {
    await supabase
      .from(target.table)
      .update({ [target.col]: orderStatus, updated_at: nowIso })
      .eq("id", target.id)
  }
}

/**
 * POST /api/admin/orders/recover-xpress-reversals
 *
 * Time-window reconciliation: fetches ALL Xpress tracking rows updated
 * within the requested window (default 72 h), checks each against the live
 * Xpress API, and corrects mismatches.
 *
 * Body: { hours?: number }  (default 72, max 720)
 *
 * Matrix:
 *   our=completed  xpress=failed    → reversed  (push alert sent)
 *   our=processing xpress=completed → completed
 *   our=processing xpress=failed    → requeued  (tracking=failed, order=pending)
 *   our=failed     xpress=completed → restored
 *   anything else / Xpress unreachable → skipped (no change)
 */
export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const body = await request.json().catch(() => ({}))
    const hours = Math.min(Math.max(Number(body.hours) || 72, 1), 720)
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()

    // All Xpress rows in the window — no status filter
    const { data: rows, error: fetchErr } = await supabase
      .from("mtn_fulfillment_tracking")
      .select("id, mtn_order_id, status, order_type, order_id, shop_order_id, api_order_id, updated_at")
      .eq("provider", "xpress")
      .gte("updated_at", since)
      .order("updated_at", { ascending: false })
      .limit(500)

    if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 })

    if (!rows || rows.length === 0) {
      return NextResponse.json({
        success: true,
        message: `No Xpress orders in the past ${hours}h`,
        hours, total: 0, fixed: 0, reversed: 0, completed: 0, requeued: 0, restored: 0, skipped: 0, results: [],
      })
    }

    console.log(`[XPRESS-RECONCILE] ${rows.length} rows in past ${hours}h`)

    type Action = "reversed" | "completed" | "requeued" | "restored" | "skipped"
    const results: Array<{ mtn_order_id: string; was: string; action: Action; message: string }> = []

    let reversed  = 0
    let completed = 0
    let requeued  = 0
    let restored  = 0
    let skipped   = 0

    const nowIso = new Date().toISOString()

    for (const row of rows) {
      const our = row.status as string

      if (!row.mtn_order_id) {
        results.push({ mtn_order_id: "(none)", was: our, action: "skipped", message: "No mtn_order_id" })
        skipped++
        continue
      }

      const { success, status: xpress } = await checkMTNOrderStatus(row.mtn_order_id, "xpress")

      // Xpress unreachable, 404, or rate-limited — skip without touching the row
      if (!success || !xpress) {
        results.push({ mtn_order_id: String(row.mtn_order_id), was: our, action: "skipped", message: "Xpress did not return a status" })
        skipped++
        continue
      }

      if (our === "completed" && xpress === "failed") {
        await setStatus(row.id, row, "reversed", "reversed", "Flagged reversed by reconciliation scan", nowIso)
        notifyAdminsPush({
          title: "⚠️ Xpress reversed a completed order",
          body: `Order ${String(row.mtn_order_id).slice(0, 8)} completed→failed — flagged reversed`,
          data: { url: "/admin/orders" },
        }).catch(() => {})
        results.push({ mtn_order_id: String(row.mtn_order_id), was: our, action: "reversed", message: "Xpress says failed — flagged reversed" })
        reversed++

      } else if ((our === "processing" || our === "pending") && xpress === "completed") {
        await setStatus(row.id, row, "completed", "completed", "Marked completed by reconciliation scan", nowIso)
        results.push({ mtn_order_id: String(row.mtn_order_id), was: our, action: "completed", message: "Xpress confirms delivery" })
        completed++

      } else if (our === "processing" && xpress === "failed") {
        await setStatus(row.id, row, "failed", "pending", "Failed — re-queued by reconciliation scan", nowIso)
        results.push({ mtn_order_id: String(row.mtn_order_id), was: our, action: "requeued", message: "Xpress says failed — order re-queued" })
        requeued++

      } else if (our === "failed" && xpress === "completed") {
        await setStatus(row.id, row, "completed", "completed", "Restored by reconciliation scan", nowIso)
        results.push({ mtn_order_id: String(row.mtn_order_id), was: our, action: "restored", message: "Xpress confirms delivery — restored" })
        restored++

      } else {
        // Statuses agree, or xpress is pending/processing — nothing to do
        results.push({ mtn_order_id: String(row.mtn_order_id), was: our, action: "skipped", message: `our=${our} xpress=${xpress} — no change` })
        skipped++
      }
    }

    const fixed = reversed + completed + requeued + restored
    console.log(`[XPRESS-RECONCILE] fixed=${fixed} reversed=${reversed} completed=${completed} requeued=${requeued} restored=${restored} skipped=${skipped}`)

    return NextResponse.json({
      success: true,
      hours,
      total: rows.length,
      fixed,
      reversed,
      completed,
      requeued,
      restored,
      skipped,
      results,
    })
  } catch (err: any) {
    console.error("[XPRESS-RECONCILE] Unhandled error:", err)
    return NextResponse.json({ error: err.message || "Internal server error" }, { status: 500 })
  }
}
