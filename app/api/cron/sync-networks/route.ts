import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const codecraftApiUrl = process.env.CODECRAFT_API_URL || "https://api.codecraftnetwork.com/api"
const codecraftApiKey = process.env.CODECRAFT_API_KEY!

// Verify cron secret to prevent unauthorized access
const CRON_SECRET = process.env.CRON_SECRET

/**
 * Sync other network order statuses from Code Craft API
 * Networks: MTN, Telecel, AT-BigTime
 * Runs every 10 minutes via Vercel Cron
 */
export async function GET(request: NextRequest) {
  try {
    // Verify authorization (Vercel sends this header for cron jobs)
    const authHeader = request.headers.get("authorization")
    if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
      console.log("[CRON-NETWORKS] Unauthorized request")
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    console.log("[CRON-NETWORKS] Starting network order status sync (MTN, Telecel, AT-BigTime)...")

    const supabase = createClient(supabaseUrl, serviceRoleKey)

    // Get pending orders from the last 24 hours
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    // Query orders table (wallet orders) - MTN, Telecel, and AT-BigTime
    const { data: walletOrders, error: walletError } = await supabase
      .from("orders")
      .select("id, reference_code, network, phone_number, data_size_gb, status")
      .in("status", ["pending", "processing"])
      .or("network.ilike.%MTN%,network.ilike.%Telecel%,network.ilike.%TELECEL%,network.ilike.%BigTime%,network.ilike.%Big Time%")
      .gte("created_at", twentyFourHoursAgo)
      .limit(50) // Process max 50 per run

    if (walletError) {
      console.error("[CRON-NETWORKS] Error fetching wallet orders:", walletError)
    }

    // Query shop_orders table
    const { data: shopOrders, error: shopError } = await supabase
      .from("shop_orders")
      .select("id, reference_code, network, customer_phone, volume_gb, order_status")
      .in("order_status", ["pending", "processing"])
      .or("network.ilike.%MTN%,network.ilike.%Telecel%,network.ilike.%TELECEL%,network.ilike.%BigTime%,network.ilike.%Big Time%")
      .gte("created_at", twentyFourHoursAgo)
      .limit(50)

    if (shopError) {
      console.error("[CRON-NETWORKS] Error fetching shop orders:", shopError)
    }

    const allOrders = [
      ...(walletOrders || []).map(o => ({ ...o, orderType: "wallet" as const })),
      ...(shopOrders || []).map(o => ({ 
        ...o, 
        orderType: "shop" as const,
        status: o.order_status
      })),
    ]

    console.log(`[CRON-NETWORKS] Found ${allOrders.length} pending orders to check`)

    if (allOrders.length === 0) {
      return NextResponse.json({ 
        success: true, 
        message: "No pending network orders to sync",
        checked: 0,
        updated: 0
      })
    }

    let updatedCount = 0
    let checkedCount = 0

    for (const order of allOrders) {
      try {
        checkedCount++
        const referenceId = order.reference_code || order.id
        const networkLower = order.network?.toLowerCase() || ""

        // Determine which endpoint to use
        const isBigTime = networkLower.includes("bigtime") || networkLower.includes("big time")
        const endpoint = isBigTime ? "response_big_time.php" : "response_regular.php"

        console.log(`[CRON-NETWORKS] Checking order ${referenceId} (${order.network}) via ${endpoint}...`)

        // Call Code Craft API to check status
        const response = await fetch(`${codecraftApiUrl}/${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reference_id: referenceId,
            agent_api: codecraftApiKey,
          }),
        })

        const responseText = await response.text()
        let data: any = {}

        try {
          data = JSON.parse(responseText)
        } catch {
          const jsonMatch = responseText.match(/\{[\s\S]*\}/)
          if (jsonMatch) {
            try {
              data = JSON.parse(jsonMatch[0])
            } catch {
              console.error(`[CRON-NETWORKS] Could not parse response for ${referenceId}`)
              continue
            }
          }
        }

        console.log(`[CRON-NETWORKS] API response for ${referenceId}:`, data)

        // Check order status from API
        const orderStatus = data.order_details?.order_status?.toLowerCase() || ""
        const apiStatus = data.status?.toLowerCase() || ""

        let newStatus: string | null = null

        if (orderStatus.includes("successful") || orderStatus.includes("delivered") || orderStatus.includes("completed")) {
          newStatus = "completed"
        } else if (orderStatus.includes("failed") || orderStatus.includes("error") || apiStatus === "failed") {
          newStatus = "failed"
        }

        if (newStatus) {
          console.log(`[CRON-NETWORKS] Updating order ${referenceId} to ${newStatus}`)

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

          updatedCount++
        }
      } catch (orderError) {
        console.error(`[CRON-NETWORKS] Error checking order ${order.id}:`, orderError)
      }
    }

    console.log(`[CRON-NETWORKS] Sync complete. Checked: ${checkedCount}, Updated: ${updatedCount}`)

    return NextResponse.json({
      success: true,
      message: "Network order sync complete",
      checked: checkedCount,
      updated: updatedCount,
    })
  } catch (error) {
    console.error("[CRON-NETWORKS] Sync error:", error)
    return NextResponse.json(
      { error: "Failed to sync orders", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
