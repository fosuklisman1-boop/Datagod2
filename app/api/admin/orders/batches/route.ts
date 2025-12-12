import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Initialize Supabase with service role key
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET() {
  try {
    console.log("Fetching downloaded batches from API...")
    
    const { data, error } = await supabase
      .from("order_download_batches")
      .select("*")
      .order("created_at", { ascending: false })

    if (error) {
      console.warn("Note: order_download_batches table may not exist yet:", error.message)
      return NextResponse.json({
        success: true,
        data: [],
        count: 0
      })
    }

    console.log(`Found ${data?.length || 0} download batches`)

    // Determine order types for each batch
    const enrichedData = await Promise.all((data || []).map(async (batch: any) => {
      if (!batch.orders || batch.orders.length === 0) {
        return batch
      }

      // Check if these orders are shop orders or bulk orders
      const orderIds = batch.orders.map((o: any) => o.id)
      
      const { data: shopOrders, error: shopError } = await supabase
        .from("shop_orders")
        .select("id")
        .in("id", orderIds)
      
      const shopOrderIds = new Set(shopOrders?.map(o => o.id) || [])
      
      // Add type to each order
      const enrichedOrders = batch.orders.map((order: any) => ({
        ...order,
        type: shopOrderIds.has(order.id) ? 'shop' : 'bulk'
      }))
      
      return {
        ...batch,
        orders: enrichedOrders
      }
    }))

    return NextResponse.json({
      success: true,
      data: enrichedData,
      count: enrichedData?.length || 0
    })
  } catch (error) {
    console.error("Error fetching download batches:", error)
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : "Internal server error",
        success: false
      },
      { status: 500 }
    )
  }
}
