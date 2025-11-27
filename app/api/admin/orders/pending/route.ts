import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Initialize Supabase with service role key
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET() {
  try {
    console.log("Fetching pending orders (bulk + shop orders)...")
    
    // Fetch bulk orders from orders table
    const { data: bulkOrders, error: bulkError } = await supabase
      .from("orders")
      .select("id, created_at, phone_number, price, status, size, network")
      .eq("status", "pending")
      .order("created_at", { ascending: false })

    if (bulkError) {
      console.error("Supabase error fetching bulk orders:", bulkError)
      throw new Error(`Failed to fetch pending orders: ${bulkError.message}`)
    }

    console.log(`Found ${bulkOrders?.length || 0} pending bulk orders`)

    // Fetch shop orders (with confirmed payment)
    const { data: shopOrders, error: shopError } = await supabase
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
        created_at,
        shops(
          shop_name,
          shop_owner_id,
          shop_slug
        )
      `)
      .eq("order_status", "pending")
      .eq("payment_status", "completed")
      .order("created_at", { ascending: false })

    if (shopError) {
      console.error("Supabase error fetching shop orders:", shopError)
      throw new Error(`Failed to fetch pending shop orders: ${shopError.message}`)
    }

    console.log(`Found ${shopOrders?.length || 0} pending shop orders with confirmed payment`)

    // Map bulk orders
    const mappedBulkOrders = bulkOrders?.map((order: any) => ({
      ...order,
      order_status: order.status,
      package_name: order.size,
      network_name: order.network,
      type: "bulk"
    })) || []

    // Map shop orders
    const mappedShopOrders = shopOrders?.map((order: any) => ({
      id: order.id,
      shop_id: order.shop_id,
      shop_name: order.shops?.shop_name,
      shop_owner_id: order.shops?.shop_owner_id,
      shop_slug: order.shops?.shop_slug,
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
      type: "shop"
    })) || []

    // Combine both orders
    const allOrders = [...mappedBulkOrders, ...mappedShopOrders]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    return NextResponse.json({
      success: true,
      data: allOrders,
      count: allOrders.length,
      bulkCount: mappedBulkOrders.length,
      shopCount: mappedShopOrders.length
    })
  } catch (error) {
    console.error("Error fetching pending orders:", error)
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : "Internal server error",
        success: false
      },
      { status: 500 }
    )
  }
}
