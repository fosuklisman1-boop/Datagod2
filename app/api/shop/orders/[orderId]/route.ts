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
    const { data: order, error } = await supabase
      .from("shop_orders")
      .select("*")
      .eq("id", orderId)
      .single()

    if (error) {
      if (error.code === "PGRST116") {
        return NextResponse.json({ error: "Order not found" }, { status: 404 })
      }
      throw new Error(`Failed to fetch order: ${error.message}`)
    }

    // Fetch shop owner contact info so customer knows who to contact
    const { data: shop } = await supabase
      .from("user_shops")
      .select("user_id")
      .eq("id", order.shop_id)
      .single()

    let shopOwner: { email?: string; phone?: string } = {}
    if (shop?.user_id) {
      const { data: userData } = await supabase
        .from("users")
        .select("phone_number")
        .eq("id", shop.user_id)
        .single()

      const { data: authData } = await supabase.auth.admin.getUserById(shop.user_id)

      shopOwner = {
        email: authData?.user?.email || undefined,
        phone: userData?.phone_number || undefined,
      }
    }

    return NextResponse.json({ success: true, order, shopOwner })
  } catch (error) {
    console.error("[SHOP-ORDER-GET] ✗ Error:", error)
    return NextResponse.json(
      { error: "Failed to load order details. Please try again." },
      { status: 500 }
    )
  }
}
