import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ shopId: string }> }
) {
  try {
    const { shopId } = await params

    if (!shopId) {
      return NextResponse.json(
        { error: "Missing shopId" },
        { status: 400 }
      )
    }

    // Parallelize all three queries instead of sequential, with specific column selection
    const [shopResult, ordersResult, profitsResult] = await Promise.all([
      supabase
        .from("user_shops")
        .select("id, shop_name, shop_slug, description, is_active, created_at, user_id")
        .eq("id", shopId)
        .single(),
      supabase
        .from("shop_orders")
        .select("id, shop_id, user_id, customer_phone, network, volume_gb, transaction_id, order_status, payment_status, created_at")
        .eq("shop_id", shopId),
      supabase
        .from("shop_profits")
        .select("id, shop_id, shop_order_id, profit_amount, status, created_at")
        .eq("shop_id", shopId)
    ])

    const { data: shop, error: shopError } = shopResult

    if (shopError) {
      console.error("Error fetching shop:", shopError)
      return NextResponse.json(
        { error: shopError.message },
        { status: 500 }
      )
    }

    const { data: orders } = ordersResult
    const { data: profits } = profitsResult

    return NextResponse.json({
      success: true,
      data: {
        shop,
        orders: orders || [],
        profits: profits || []
      }
    })
  } catch (error: any) {
    console.error("Error in GET /api/admin/shops/[shopId]:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
