import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Initialize Supabase with service role key
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET() {
  try {
    console.log("Fetching pending shop orders (payment confirmed)...")
    
    // Fetch shop orders where:
    // 1. order_status is "pending" (not yet processed by admin)
    // 2. payment_status is "completed" (payment has been verified)
    const { data, error } = await supabase
      .from("shop_orders")
      .select(`
        id,
        shop_id,
        customer_name,
        customer_phone,
        customer_email,
        network,
        volume_gb,
        base_price,
        profit_amount,
        total_price,
        order_status,
        payment_status,
        reference_code,
        created_at
      `)
      .eq("order_status", "pending")
      .eq("payment_status", "completed")
      .order("created_at", { ascending: false })

    if (error) {
      console.error("Supabase error:", error)
      throw new Error(`Failed to fetch pending shop orders: ${error.message}`)
    }

    console.log(`Found ${data?.length || 0} pending shop orders with confirmed payment`)

    // Map response for frontend compatibility
    const mappedData = data?.map((order: any) => ({
      id: order.id,
      shop_id: order.shop_id,
      customer_name: order.customer_name,
      phone_number: order.customer_phone,
      customer_email: order.customer_email,
      network: order.network,
      size: order.volume_gb,
      price: order.total_price,
      base_price: order.base_price,
      profit_amount: order.profit_amount,
      status: order.order_status,
      payment_status: order.payment_status,
      reference_code: order.reference_code,
      created_at: order.created_at,
      type: "shop" // Mark as shop order
    })) || []

    return NextResponse.json({
      success: true,
      data: mappedData,
      count: mappedData.length
    })
  } catch (error) {
    console.error("Error fetching pending shop orders:", error)
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : "Internal server error",
        success: false
      },
      { status: 500 }
    )
  }
}
