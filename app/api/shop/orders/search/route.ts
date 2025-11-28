import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Initialize Supabase with service role key
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  try {
    const { phone, shopId } = await request.json()

    if (!phone || !shopId) {
      return NextResponse.json(
        { error: "Phone number and shop ID are required" },
        { status: 400 }
      )
    }

    console.log(`[SHOP-ORDER-SEARCH] Searching for orders - phone: ${phone}, shop: ${shopId}`)

    // Search for shop orders with matching phone and shop_id
    const { data: orders, error } = await supabase
      .from("shop_orders")
      .select(
        `id, customer_name, customer_email, customer_phone, 
         package_id, network, volume_gb, base_price, profit_amount, 
         total_price, order_status, payment_status, reference_code, 
         created_at, updated_at`
      )
      .eq("shop_id", shopId)
      .eq("customer_phone", phone.trim())
      .order("created_at", { ascending: false })

    if (error) {
      console.error("[SHOP-ORDER-SEARCH] Error:", error)
      throw new Error(`Failed to search orders: ${error.message}`)
    }

    console.log(`[SHOP-ORDER-SEARCH] Found ${orders?.length || 0} orders for this phone and shop`)

    return NextResponse.json({
      success: true,
      orders: orders || [],
      count: orders?.length || 0
    })
  } catch (error) {
    console.error("[SHOP-ORDER-SEARCH] Error searching orders:", error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
        success: false
      },
      { status: 500 }
    )
  }
}
