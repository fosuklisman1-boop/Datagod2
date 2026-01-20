import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const codecraftApiUrl = process.env.CODECRAFT_API_URL || "https://codecraft-api-url.com"
const codecraftApiKey = process.env.CODECRAFT_API_KEY || ""

const supabase = createClient(supabaseUrl, serviceRoleKey)

// Networks that are auto-fulfilled via CodeCraft API and can be synced
const CODECRAFT_NETWORKS = ["at-ishare", "at - ishare", "telecel", "at-bigtime", "at - bigtime", "at - big time"]

/**
 * Check if a network is fulfilled via CodeCraft (can be synced)
 */
function isCodeCraftNetwork(network: string): boolean {
  const networkLower = (network || "").toLowerCase().trim()
  return CODECRAFT_NETWORKS.some(n => networkLower.includes(n.replace("-", " ")) || networkLower.includes(n))
}

/**
 * API endpoint to sync all processing orders with CodeCraft
 * Forces a verification check for orders that were sent to CodeCraft
 * Only syncs AT-iShare, Telecel, and AT-BigTime orders (NOT MTN)
 */
export async function POST(request: NextRequest) {
  try {
    console.log("[SYNC-ORDERS] Starting sync of CodeCraft orders...")

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

    // Filter to only include CodeCraft networks (AT-iShare, Telecel, BigTime)
    // MTN orders are manually fulfilled and should NOT be synced with CodeCraft
    const allOrders = [
      ...(walletOrders.data || [])
        .filter(o => isCodeCraftNetwork(o.network))
        .map(o => ({ ...o, orderType: "wallet" as const })),
      ...(shopOrders.data || [])
        .filter(o => isCodeCraftNetwork(o.network))
        .map(o => ({ 
          id: o.id, 
          phone_number: o.customer_phone, 
          network: o.network,
          size: o.volume_gb,
          created_at: o.created_at,
          orderType: "shop" as const 
        }))
    ]

    // Count how many were skipped (non-CodeCraft networks like MTN)
    const totalProcessing = (walletOrders.data?.length || 0) + (shopOrders.data?.length || 0)
    const skippedCount = totalProcessing - allOrders.length

    if (skippedCount > 0) {
      console.log(`[SYNC-ORDERS] Skipped ${skippedCount} orders (MTN/non-CodeCraft networks - these are manually fulfilled)`)
    }

    if (allOrders.length === 0) {
      return NextResponse.json({
        success: true,
        message: skippedCount > 0 
          ? `No CodeCraft orders to sync. ${skippedCount} MTN/manual orders were skipped (sync not applicable).`
          : "No processing orders found",
        checked: 0,
        updated: 0,
        completed: 0,
        failed: 0,
        skipped: skippedCount,
      })
    }

    console.log(`[SYNC-ORDERS] Found ${allOrders.length} CodeCraft orders to sync`)


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
        
        // Look up the CodeCraft reference from fulfillment_logs
        const { data: fulfillmentLog } = await supabase
          .from("fulfillment_logs")
          .select("api_response")
          .eq("order_id", order.id)
          .single()
        
        // Use CodeCraft reference if available, otherwise use our order ID
        const codecraftRef = fulfillmentLog?.api_response?.codecraft_reference || 
                             fulfillmentLog?.api_response?.reference_id ||
                             order.id
        
        // Determine correct endpoint
        const endpoint = isBigTime ? "response_big_time.php" : "response_regular.php"
        const url = `${codecraftApiUrl}/${endpoint}?reference_id=${encodeURIComponent(codecraftRef)}`

        console.log(`[SYNC-ORDERS] Checking order ${order.id} (CodeCraft ref: ${codecraftRef}, type: ${order.orderType})...`)

        // Call CodeCraft API to verify order status with GET and x-api-key header
        const response = await fetch(url, {
          method: "GET",
          headers: { 
            "x-api-key": codecraftApiKey,
          },
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

        // New API format: { status: 200, success: true, data: { order_status: "..." } }
        // Check multiple possible status locations for backwards compatibility
        const orderStatus = (
          data.data?.order_status ||  // New format
          data.order_details?.order_status ||  // Legacy format
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
          message = data.data?.order_status || data.order_details?.order_status || data.message || "Delivery failed at CodeCraft"
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

    console.log(`[SYNC-ORDERS] Complete. Checked: ${checked}, Updated: ${updated}, Completed: ${completed}, Failed: ${failed}, Skipped: ${skippedCount}`)

    return NextResponse.json({
      success: true,
      message: skippedCount > 0
        ? `Synced ${checked} CodeCraft orders. ${skippedCount} MTN/manual orders skipped.`
        : `Synced ${checked} orders with CodeCraft`,
      checked,
      updated,
      completed,
      failed,
      skipped: skippedCount,
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
