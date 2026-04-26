import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  const orderId   = request.nextUrl.searchParams.get("orderId")
  const reference = request.nextUrl.searchParams.get("reference")

  if (!orderId || !reference) {
    return NextResponse.json({ error: "orderId and reference are required" }, { status: 400 })
  }

  const { data: order } = await supabase
    .from("results_checker_orders")
    .select("id, reference_code, exam_board, quantity, total_paid, status, inventory_ids, created_at")
    .eq("id", orderId)
    .single()

  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 })
  }

  // Validate the Paystack payment reference belongs to this order
  const { data: payment } = await supabase
    .from("wallet_payments")
    .select("order_id")
    .eq("reference", reference)
    .single()

  if (!payment || payment.order_id !== orderId) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 })
  }

  let vouchers: Array<{ pin: string; serial_number: string | null }> = []
  if (order.status === "completed" && order.inventory_ids?.length) {
    const { data: inv } = await supabase
      .from("results_checker_inventory")
      .select("pin, serial_number")
      .in("id", order.inventory_ids)
    vouchers = inv ?? []
  }

  return NextResponse.json({ order, vouchers })
}
