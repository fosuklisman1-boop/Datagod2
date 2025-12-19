import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Initialize Supabase with service role key
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

// Normalize network names to title case
function normalizeNetwork(network: string): string {
  if (!network) return network
  const networkMap: { [key: string]: string } = {
    "mtn": "MTN",
    "telecel": "Telecel",
    "at": "AT",
    "at - ishare": "AT - iShare",
    "at - bigtime": "AT - BigTime",
    "ishare": "iShare",
  }
  const lower = network.toLowerCase().trim()
  return networkMap[lower] || network.toUpperCase().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

export async function GET() {
  try {
    console.log("Fetching pending orders (bulk + shop orders)...")
    
    // Fetch bulk orders from orders table
    const { data: bulkOrders, error: bulkError } = await supabase
      .from("orders")
      .select("id, created_at, phone_number, price, status, size, network")
      .eq("status", "pending")
      .neq("network", "AT-iShare")
      .order("created_at", { ascending: false })

    if (bulkError) {
      console.error("Supabase error fetching bulk orders:", bulkError)
      throw new Error(`Failed to fetch pending orders: ${bulkError.message}`)
    }

    console.log(`Found ${bulkOrders?.length || 0} pending bulk orders`)
    if (bulkOrders && bulkOrders.length > 0) {
      console.log("Bulk orders networks:", bulkOrders.map(o => o.network))
    }

    // Fetch shop orders (with confirmed payment only - exclude null payment_status)
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
        created_at
      `)
      .eq("order_status", "pending")
      .eq("payment_status", "completed")
      .not("payment_status", "is", null)
      .neq("network", "AT-iShare")
      .order("created_at", { ascending: false })

    if (shopError) {
      console.error("Supabase error fetching shop orders:", shopError)
      throw new Error(`Failed to fetch pending shop orders: ${shopError.message}`)
    }

    console.log(`Found ${shopOrders?.length || 0} pending shop orders with confirmed payment`)
    if (shopOrders && shopOrders.length > 0) {
      console.log("Shop orders networks:", shopOrders.map(o => o.network))
    }

    // Map bulk orders
    const mappedBulkOrders = bulkOrders?.map((order: any) => ({
      id: order.id,
      phone_number: order.phone_number,
      network: normalizeNetwork(order.network),
      size: order.size,
      price: order.price,
      status: order.status,
      order_status: order.status,
      created_at: order.created_at,
      type: "bulk"
    })) || []

    // Map shop orders
    const mappedShopOrders = shopOrders?.map((order: any) => ({
      id: order.id,
      shop_id: order.shop_id,
      shop_name: order.shop_id, // Will be populated by shop_id on frontend or we can do a separate join
      customer_name: order.customer_name,
      phone_number: order.customer_phone,
      customer_email: order.customer_email,
      network: normalizeNetwork(order.network),
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

    console.log("All pending orders by network:", allOrders.reduce((acc: any, o: any) => {
      if (!acc[o.network]) acc[o.network] = 0
      acc[o.network]++
      return acc
    }, {}))

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
