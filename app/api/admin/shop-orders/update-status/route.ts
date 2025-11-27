import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Initialize Supabase with service role key
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  try {
    const { orderIds, status } = await request.json()

    if (!orderIds || orderIds.length === 0) {
      return NextResponse.json(
        { error: "No order IDs provided" },
        { status: 400 }
      )
    }

    if (!status) {
      return NextResponse.json(
        { error: "Status is required" },
        { status: 400 }
      )
    }

    console.log(`[SHOP-ORDERS-UPDATE] Updating ${orderIds.length} shop orders to status: ${status}`)

    // Update shop order status
    const { error: updateError } = await supabase
      .from("shop_orders")
      .update({ order_status: status, updated_at: new Date().toISOString() })
      .in("id", orderIds)

    if (updateError) {
      console.error("[SHOP-ORDERS-UPDATE] Error updating shop orders:", updateError)
      throw new Error(`Failed to update shop order status: ${updateError.message}`)
    }

    console.log(`[SHOP-ORDERS-UPDATE] ✓ Updated ${orderIds.length} shop orders to status: ${status}`)

    // If status is "completed", credit the associated profits
    if (status === "completed") {
      console.log(`[SHOP-ORDERS-UPDATE] Crediting profits for ${orderIds.length} completed orders...`)

      // Get the profit records for these orders
      const { data: profitRecords, error: profitFetchError } = await supabase
        .from("shop_profits")
        .select("id, shop_id, profit_amount, status")
        .in("shop_order_id", orderIds)
        .eq("status", "pending")

      if (profitFetchError) {
        console.error("[SHOP-ORDERS-UPDATE] Error fetching profit records:", profitFetchError)
        throw new Error(`Failed to fetch profit records: ${profitFetchError.message}`)
      }

      console.log(`[SHOP-ORDERS-UPDATE] Found ${profitRecords?.length || 0} pending profit records`)

      if (profitRecords && profitRecords.length > 0) {
        // Update profit records to "credited"
        const profitIds = profitRecords.map(p => p.id)
        const { error: profitUpdateError } = await supabase
          .from("shop_profits")
          .update({ status: "credited", updated_at: new Date().toISOString() })
          .in("id", profitIds)

        if (profitUpdateError) {
          console.error("[SHOP-ORDERS-UPDATE] Error updating profit records:", profitUpdateError)
          throw new Error(`Failed to update profit records: ${profitUpdateError.message}`)
        }

        console.log(`[SHOP-ORDERS-UPDATE] ✓ Credited ${profitRecords.length} profit records`)

        // Log profit details
        const totalProfit = profitRecords.reduce((sum, p) => sum + p.profit_amount, 0)
        console.log(`[SHOP-ORDERS-UPDATE] Total profit credited: GHS ${totalProfit.toFixed(2)}`)
      }
    }

    return NextResponse.json({
      success: true,
      count: orderIds.length,
      status,
      profitsUpdated: status === "completed"
    })
  } catch (error) {
    console.error("[SHOP-ORDERS-UPDATE] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
