import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// GET /api/shop/afa/status?orderId=<ussd_afa_orders.id>
// The Paystack webhook is the source of truth for completion (this route
// never calls it) -- the confirmation page just polls this until the
// webhook has done its work.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const orderId = searchParams.get("orderId")
  if (!orderId) {
    return NextResponse.json({ error: "orderId is required" }, { status: 400 })
  }

  const { data, error } = await supabase
    .from("ussd_afa_orders")
    .select("id, full_name, amount, payment_status, order_status, fulfillment_status, created_at")
    .eq("id", orderId)
    .single()

  if (error || !data) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 })
  }

  return NextResponse.json({ data })
}
