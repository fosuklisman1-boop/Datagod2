import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(
  request: NextRequest,
  { params }: { params: { shopId: string } }
) {
  try {
    const shopId = params.shopId

    if (!shopId) {
      return NextResponse.json(
        { error: "Missing shopId" },
        { status: 400 }
      )
    }

    // Get shop details
    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("*")
      .eq("id", shopId)
      .single()

    if (shopError) {
      console.error("Error fetching shop:", shopError)
      return NextResponse.json(
        { error: shopError.message },
        { status: 500 }
      )
    }

    // Get shop orders
    const { data: orders } = await supabase
      .from("shop_orders")
      .select("*")
      .eq("shop_id", shopId)

    // Get shop profits
    const { data: profits } = await supabase
      .from("shop_profits")
      .select("*")
      .eq("shop_id", shopId)

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
