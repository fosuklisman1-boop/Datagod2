import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { fulfillAfaOrder } from "@/lib/afa-fulfillment"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * POST /api/admin/afa-fulfillment
 *
 * Actions:
 *   { action: "fulfill-one",     orderId: string }
 *   { action: "fulfill-pending"                  }  — all unfulfilled + non-cancelled
 */
export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const body = await request.json()
  const { action, orderId } = body

  // ── fulfill-one ──────────────────────────────────────────────────────────
  if (action === "fulfill-one") {
    if (!orderId || typeof orderId !== "string") {
      return NextResponse.json({ error: "orderId is required" }, { status: 400 })
    }

    const result = await fulfillAfaOrder(orderId)

    return NextResponse.json(result, { status: result.success ? 200 : 400 })
  }

  // ── fulfill-pending ───────────────────────────────────────────────────────
  if (action === "fulfill-pending") {
    const { data: orders, error: fetchError } = await supabase
      .from("afa_orders")
      .select("id")
      .eq("status", "pending")
      .or("fulfillment_status.is.null,fulfillment_status.in.(unfulfilled,failed)")
      .order("created_at", { ascending: true })

    if (fetchError) {
      console.error("[AFA-FULFILL-BULK] Fetch error:", fetchError)
      return NextResponse.json({ error: fetchError.message }, { status: 500 })
    }

    if (!orders || orders.length === 0) {
      return NextResponse.json({ success: true, message: "No unfulfilled orders found", fulfilled: 0, failed: 0 })
    }

    console.log(`[AFA-FULFILL-BULK] Processing ${orders.length} orders`)

    let fulfilled = 0
    let failed = 0
    const errors: Array<{ orderId: string; message: string }> = []

    for (const order of orders) {
      const result = await fulfillAfaOrder(order.id)
      if (result.success) {
        fulfilled++
      } else {
        failed++
        errors.push({ orderId: order.id, message: result.message })
      }
    }

    return NextResponse.json({
      success: true,
      total: orders.length,
      fulfilled,
      failed,
      errors: errors.length > 0 ? errors : undefined,
      message: `Processed ${orders.length} orders: ${fulfilled} fulfilled, ${failed} failed.`,
    })
  }

  return NextResponse.json({ error: "Unknown action. Use 'fulfill-one' or 'fulfill-pending'." }, { status: 400 })
}
