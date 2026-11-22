import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { maskBuyerPhone } from "@/lib/shop-order-privacy"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Public endpoint (anyone holding an order id): return only what the confirmation
// screens show. Never buyer details, cost, profit or internal references.
const AIRTIME_COLUMNS = "id, reference_code, network, status, payment_status, airtime_amount, total_paid, beneficiary_phone, created_at"
const DATA_COLUMNS = "id, reference_code, network, volume_gb, total_price, order_status, payment_status, created_at, updated_at"

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const orderId = searchParams.get("orderId")
    const isAirtime = searchParams.get("type") === "airtime"

    if (!orderId) {
      return NextResponse.json({ error: "Order ID is required" }, { status: 400 })
    }

    const { data, error } = await supabase
      .from(isAirtime ? "airtime_orders" : "shop_orders")
      .select(isAirtime ? AIRTIME_COLUMNS : DATA_COLUMNS)
      .eq("id", orderId)
      .single()

    if (error || !data) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 })
    }

    // Built field by field: a row can never carry an extra column into the response.
    const o = data as Record<string, any>
    const out = isAirtime
      ? {
          id: o.id,
          reference_code: o.reference_code,
          network: o.network,
          status: o.status,
          payment_status: o.payment_status,
          airtime_amount: o.airtime_amount,
          total_paid: o.total_paid,
          beneficiary_phone: maskBuyerPhone(o.beneficiary_phone),
          created_at: o.created_at,
        }
      : {
          id: o.id,
          reference_code: o.reference_code,
          network: o.network,
          volume_gb: o.volume_gb,
          total_price: o.total_price,
          order_status: o.order_status,
          payment_status: o.payment_status,
          created_at: o.created_at,
          updated_at: o.updated_at,
        }

    return NextResponse.json({ data: out })
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
