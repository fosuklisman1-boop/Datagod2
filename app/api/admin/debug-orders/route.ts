import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const shopId = searchParams.get("shopId")

    if (!shopId) {
      return NextResponse.json({ error: "shopId required" }, { status: 400 })
    }

    // Get all shop orders for this shop
    const { data: orders, error: ordersError } = await supabase
      .from("shop_orders")
      .select("*")
      .eq("shop_id", shopId)

    if (ordersError) throw ordersError

    return NextResponse.json({
      shopId,
      orderCount: orders?.length || 0,
      orders: orders,
    })
  } catch (error) {
    console.error("Debug error:", error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
