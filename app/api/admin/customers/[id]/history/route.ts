import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// Helper to fetch all customer orders with pagination
async function fetchAllCustomerOrders(shopId: string, customerId: string) {
  let allOrders: any[] = []
  let offset = 0
  const batchSize = 1000
  let hasMore = true

  while (hasMore) {
    const { data, error } = await supabase
      .from("shop_orders")
      .select(`
        id,
        reference_code,
        network,
        volume_gb,
        total_price,
        order_status,
        payment_status,
        created_at
      `)
      .eq("shop_customer_id", customerId)
      .eq("shop_id", shopId)
      .order("created_at", { ascending: false })
      .range(offset, offset + batchSize - 1)

    if (error) throw error

    if (data && data.length > 0) {
      allOrders = allOrders.concat(data)
      offset += batchSize
      hasMore = data.length === batchSize
    } else {
      hasMore = false
    }
  }

  return allOrders
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { params } = context
  const { id } = await params
  try {
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
    }

    const userId = authHeader.slice(7)

    // Get user's shop
    const { data: shop } = await supabase.from("shops").select("id").eq("user_id", userId).single()

    if (!shop) {
      return NextResponse.json({ success: false, error: "Shop not found" }, { status: 404 })
    }

    // Get customer (verify ownership)
    const { data: customer } = await supabase
      .from("shop_customers")
      .select("id")
      .eq("id", id)
      .eq("shop_id", shop.id)
      .single()

    if (!customer) {
      return NextResponse.json({ success: false, error: "Customer not found" }, { status: 404 })
    }

    // Get customer's orders with pagination (handles >1000 orders)
    const orders = await fetchAllCustomerOrders(shop.id, id)

    return NextResponse.json({
      success: true,
      orders: orders || [],
    })
  } catch (error) {
    console.error("Error in customer history endpoint:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
