import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const codecraftApiUrl = process.env.CODECRAFT_API_URL || "https://codecraft-api-url.com"
const codecraftApiKey = process.env.CODECRAFT_API_KEY || ""

const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * API endpoint to sync all processing orders with CodeCraft
 * Forces a verification check for ALL orders stuck at "processing" status
 */
export async function POST(request: NextRequest) {
  try {
    console.log("[SYNC-ORDERS] Starting sync of all processing orders with CodeCraft...")

    // Find all orders with "processing" status from both tables
    const [walletOrders, shopOrders] = await Promise.all([
      supabase
        .from("orders")
        .select("id, phone_number, network, size, created_at")
        .eq("status", "processing")
        .order("created_at", { ascending: true }),
      supabase
        .from("shop_orders")
        .select("id, customer_phone, network, volume_gb, created_at")
        .eq("order_status", "processing")
        .order("created_at", { ascending: true })
    ])

    const allOrders = [
      ...(walletOrders.data || []).map(o => ({ ...o, orderType: "wallet" as const })),
      ...(shopOrders.data || []).map(o => ({ 
        id: o.id, 
        phone_number: o.customer_phone, 
        network: o.network,
        size: o.volume_gb,
        created_at: o.created_at,
        orderType: "shop" as const 
      }))
    ]

    if (allOrders.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No processing orders found",
        checked: 0,
        updated: 0,
        completed: 0,
        failed: 0,
      })
    }

    console.log(`[SYNC-ORDERS] Found ${allOrders.length} orders to check (${walletOrders.data?.length || 0} wallet, ${shopOrders.data?.length || 0} shop)`)

    let checked = 0
    let updated = 0
    let completed = 0
    let failed = 0
    const results: { orderId: string; status: string; message: string }[] = []

    for (const order of allOrders) {
      try {
        checked++
        const networkLower = (order.network || "").toLowerCase()
        const isBigTime = networkLower.includes("bigtime") || networkLower.includes("big time")
        
        // Determine correct endpoint
        const endpoint = isBigTime ? "response_big_time.php" : "response_regular.php"
        const url = `${codecraftApiUrl}/${endpoint}`

        console.log(`[SYNC-ORDERS] Checking order ${order.id} (${order.orderType})...`)

        // Call CodeCraft API to verify order status
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reference_id: order.id,
            agent_api: codecraftApiKey,
          }),
        })

        const responseText = await response.text()
        let data: any = {}

        try {
          data = JSON.parse(responseText)
        } catch {
          // Try to extract JSON from mixed response
          const jsonMatch = responseText.match(/\{[\s\S]*\}/)
          if (jsonMatch) {
            try {
              data = JSON.parse(jsonMatch[0])
            } catch {
              console.warn(`[SYNC-ORDERS] Could not parse response for order ${order.id}`)
            }
          }
        }

        // Check multiple possible status locations
        const orderStatus = (
          data.order_details?.order_status || 
          data.order_status || 
          data.status || 
          ""
        ).toLowerCase()

        console.log(`[SYNC-ORDERS] Order ${order.id} CodeCraft status: "${orderStatus}"`)

        let newStatus = "processing"
        let message = ""

        if (orderStatus.includes("successful") || orderStatus.includes("delivered") || orderStatus.includes("completed") || orderStatus === "success") {
          newStatus = "completed"
          message = "Verified as delivered at CodeCraft"
          completed++
        } else if (orderStatus.includes("failed") || orderStatus.includes("error") || orderStatus.includes("cancelled") || orderStatus.includes("canceled") || orderStatus.includes("rejected") || orderStatus.includes("refund")) {
          newStatus = "failed"
          message = data.order_details?.order_status || data.message || "Delivery failed at CodeCraft"
          failed++
        } else {
          // Still processing or unknown status
          message = `Still processing at CodeCraft (status: ${orderStatus || "unknown"})`
        }

        // Update order status if changed
        if (newStatus !== "processing") {
          updated++
          
          if (order.orderType === "wallet") {
            await supabase
              .from("orders")
              .update({ status: newStatus, updated_at: new Date().toISOString() })
              .eq("id", order.id)
          } else {
            await supabase
              .from("shop_orders")
              .update({ order_status: newStatus, updated_at: new Date().toISOString() })
              .eq("id", order.id)
          }

          // Update fulfillment log if exists
          await supabase
            .from("fulfillment_logs")
            .update({ 
              status: newStatus === "completed" ? "success" : newStatus,
              updated_at: new Date().toISOString()
            })
            .eq("order_id", order.id)

          console.log(`[SYNC-ORDERS] ✓ Order ${order.id} updated to ${newStatus}`)
        }

        results.push({
          orderId: order.id,
          status: newStatus,
          message
        })

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500))

      } catch (orderError) {
        console.error(`[SYNC-ORDERS] Error checking order ${order.id}:`, orderError)
        results.push({
          orderId: order.id,
          status: "error",
          message: orderError instanceof Error ? orderError.message : "Unknown error"
        })
      }
    }

    console.log(`[SYNC-ORDERS] Complete. Checked: ${checked}, Updated: ${updated}, Completed: ${completed}, Failed: ${failed}`)

    return NextResponse.json({
      success: true,
      message: `Synced ${checked} orders with CodeCraft`,
      checked,
      updated,
      completed,
      failed,
      stillProcessing: checked - updated,
      results,
    })
  } catch (error) {
    console.error("[SYNC-ORDERS] Error:", error)
    return NextResponse.json(
      { error: "Failed to sync orders", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
