import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Initialize Supabase with service role key
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET() {
  try {
    console.log("Fetching all pending orders (bulk orders from orders table)...")
    
    // Fetch regular bulk orders (from orders table)
    const { data: bulkOrders, error: bulkError } = await supabase
      .from("orders")
      .select("id, created_at, phone_number, price, status, size, network")
      .eq("status", "pending")
      .order("created_at", { ascending: false })

    if (bulkError) {
      console.error("Supabase error fetching bulk orders:", bulkError)
      throw new Error(`Failed to fetch bulk orders: ${bulkError.message}`)
    }

    // Map bulk orders response for compatibility
    const mappedBulkOrders = bulkOrders?.map((order: any) => ({
      id: order.id,
      phone_number: order.phone_number,
      network: order.network,
      size: order.size,
      price: order.price,
      status: order.status,
      order_status: order.status,
      package_name: order.size,
      network_name: order.network,
      created_at: order.created_at,
      type: "bulk" // Mark as bulk order
    })) || []

    console.log(`Found ${mappedBulkOrders.length} pending bulk orders`)

    return NextResponse.json({
      success: true,
      data: mappedBulkOrders,
      count: mappedBulkOrders.length
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
