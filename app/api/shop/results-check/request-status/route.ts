import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  const requestId = request.nextUrl.searchParams.get("requestId")
  const reference = request.nextUrl.searchParams.get("reference")

  if (!requestId || !reference) {
    return NextResponse.json({ error: "requestId and reference are required" }, { status: 400 })
  }

  const { data: checkRequest } = await supabase
    .from("results_check_requests")
    .select("id, payment_reference, exam_board, mode, index_number, exam_year, fee, payment_status, status, voucher_pin, voucher_serial, whatsapp_number, created_at")
    .eq("id", requestId)
    .single()

  if (!checkRequest) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 })
  }

  // Validate the Paystack payment reference belongs to this request
  const { data: payment } = await supabase
    .from("wallet_payments")
    .select("order_id")
    .eq("reference", reference)
    .single()

  if (!payment || payment.order_id !== requestId) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 })
  }

  return NextResponse.json({ request: checkRequest })
}
