import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  try {
    const { orderId } = await params
    if (!orderId) {
      return NextResponse.json({ error: "Order ID is required" }, { status: 400 })
    }

    // Fetch order — public endpoint: the UUID order ID acts as a tamper-proof
    // access key, so customers can view their own order after Paystack redirects them.
    // Never select(*) — only expose columns the order-tracking UI needs.
    // Excluded: base_price, profit_amount, parent_profit_amount, queue (all internal).
    const { data: order, error } = await supabase
      .from("shop_orders")
      .select("id, reference_code, order_status, payment_status, customer_name, customer_email, customer_phone, network, volume_gb, total_price, created_at, shop_id")
      .eq("id", orderId)
      .single()

    if (error) {
      if (error.code === "PGRST116") {
        return NextResponse.json({ error: "Order not found" }, { status: 404 })
      }
      throw new Error(`Failed to fetch order: ${error.message}`)
    }

    // Fetch the shop's public display name and the WhatsApp contact link the owner
    // explicitly set for customer support. This replaces the old auth.admin.getUserById
    // call that leaked the owner's private Supabase auth email.
    const [{ data: shop }, { data: settings }] = await Promise.all([
      supabase.from("user_shops").select("shop_name").eq("id", order.shop_id).single(),
      supabase.from("shop_settings").select("whatsapp_link").eq("shop_id", order.shop_id).single(),
    ])

    return NextResponse.json({
      success: true,
      order,
      shopName: shop?.shop_name ?? null,
      shopWhatsapp: settings?.whatsapp_link || null,
    })
  } catch (error) {
    console.error("[SHOP-ORDER-GET] ✗ Error:", error)
    return NextResponse.json(
      { error: "Failed to load order details. Please try again." },
      { status: 500 }
    )
  }
}
