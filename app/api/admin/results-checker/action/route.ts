import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { refundRCOrder } from "@/lib/results-checker-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const { orderId, action, notes } = await request.json()

    if (!orderId || !action) {
      return NextResponse.json({ error: "orderId and action are required" }, { status: 400 })
    }
    if (!["failed", "refund"].includes(action)) {
      return NextResponse.json({ error: "action must be 'failed' or 'refund'" }, { status: 400 })
    }

    const { data: order, error: fetchError } = await supabase
      .from("results_checker_orders")
      .select("*")
      .eq("id", orderId)
      .single()

    if (fetchError || !order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 })
    }

    if (order.status === "failed") {
      return NextResponse.json({ error: "Order is already failed" }, { status: 409 })
    }

    // Refund wallet if user exists (not a guest order)
    if (order.user_id && order.payment_status === "completed") {
      await refundRCOrder(orderId, order.user_id, Number(order.total_paid))
    } else {
      // Guest order or unpaid — just release inventory and mark failed
      await supabase
        .from("results_checker_inventory")
        .update({ status: "available", reserved_by_order: null, reservation_expires_at: null, updated_at: new Date().toISOString() })
        .eq("reserved_by_order", orderId)
        .eq("status", "reserved")

      await supabase
        .from("results_checker_orders")
        .update({ status: "failed", notes: notes ?? null, updated_at: new Date().toISOString() })
        .eq("id", orderId)
    }

    // Notify user if authenticated order
    if (order.user_id) {
      await supabase.from("notifications").insert([{
        user_id: order.user_id,
        title: "Results Checker Order Cancelled",
        message: `Your ${order.exam_board} voucher order (Ref: ${order.reference_code}) has been cancelled and refunded.`,
        type: "order_update",
        reference_id: orderId,
        action_url: `/dashboard/results-checker`,
        read: false,
      }])
    }

    console.log(`[RC-ADMIN-ACTION] Order ${order.reference_code} marked as failed by admin`)

    return NextResponse.json({ success: true, message: "Order marked as failed" + (order.user_id ? " and refunded" : "") })

  } catch (error) {
    console.error("[RC-ADMIN-ACTION] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
