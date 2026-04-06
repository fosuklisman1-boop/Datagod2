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
    // Verify authenticated user
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { orderId } = await params
    if (!orderId) {
      return NextResponse.json({ error: "Order ID is required" }, { status: 400 })
    }

    // Fetch order
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

    // Verify the authenticated user owns the shop this order belongs to
    const { data: shop } = await supabase
      .from("user_shops")
      .select("user_id")
      .eq("id", order.shop_id)
      .single()

    if (!shop || shop.user_id !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    // Fetch shop owner contact info (same user, safe to return)
    const { data: userData } = await supabase
      .from("users")
      .select("phone_number")
      .eq("id", user.id)
      .single()

    const { data: authData } = await supabase.auth.admin.getUserById(user.id)

    const shopOwner = {
      email: authData?.user?.email || undefined,
      phone: userData?.phone_number || undefined,
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
