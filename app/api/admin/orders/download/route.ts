import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Initialize Supabase with service role key
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  try {
    const { orderIds } = await request.json()

    if (!orderIds || orderIds.length === 0) {
      return NextResponse.json(
        { error: "No order IDs provided" },
        { status: 400 }
      )
    }

    // Fetch all orders
    const { data: orders, error: fetchError } = await supabase
      .from("orders")
      .select("id, created_at, phone_number, price, status, size, network")
      .in("id", orderIds)

    if (fetchError) {
      throw new Error(`Failed to fetch orders: ${fetchError.message}`)
    }

    if (!orders || orders.length === 0) {
      return NextResponse.json(
        { error: "No orders found" },
        { status: 404 }
      )
    }

    // Update order status to "processing"
    const { error: updateError } = await supabase
      .from("orders")
      .update({ status: "processing" })
      .in("id", orderIds)

    if (updateError) {
      throw new Error(`Failed to update order status: ${updateError.message}`)
    }

    // Group orders by network
    const groupedByNetwork: { [key: string]: any[] } = {}
    orders.forEach((order: any) => {
      if (!groupedByNetwork[order.network]) {
        groupedByNetwork[order.network] = []
      }
      groupedByNetwork[order.network].push(order)
    })

    // Create download batch record
    const batchTime = new Date().toISOString()
    const batchRecords = Object.entries(groupedByNetwork).map(([network, networkOrders]) => ({
      network,
      batch_time: batchTime,
      orders: networkOrders,
      order_count: networkOrders.length,
      created_at: batchTime
    }))

    // Insert batch records
    const { error: batchError } = await supabase
      .from("order_download_batches")
      .insert(batchRecords)

    if (batchError) {
      console.warn("Warning: Could not create batch records:", batchError.message)
      // Continue anyway - batch tracking is optional
    }

    // Generate CSV
    const csvHeader = [
      "Order ID",
      "Customer Phone",
      "Network",
      "Package Size (GB)",
      "Price (NGN)",
      "Status",
      "Created Date"
    ].join(",")

    const csvRows = orders.map((order: any) => [
      `"${order.id}"`,
      `"${order.phone_number || ""}"`,
      `"${order.network}"`,
      order.size,
      order.price.toFixed(2),
      order.status,
      new Date(order.created_at).toISOString().split('T')[0]
    ].join(","))

    const csv = [csvHeader, ...csvRows].join("\n")

    return NextResponse.json({
      success: true,
      count: orders.length,
      csv
    })
  } catch (error) {
    console.error("Error in download orders:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
