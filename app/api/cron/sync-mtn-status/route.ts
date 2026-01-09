import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

// Sykes API configuration
const MTN_API_BASE_URL = process.env.MTN_API_BASE_URL || "https://sykesofficial.net"
const MTN_API_KEY = process.env.MTN_API_KEY || ""

// Cron secret to prevent unauthorized access
const CRON_SECRET = process.env.CRON_SECRET

/**
 * Fetch ALL orders from Sykes API in a single call
 */
async function fetchAllSykesOrders(): Promise<{ success: boolean; orders: any[]; message?: string }> {
  try {
    console.log("[CRON] Fetching all orders from Sykes API...")
    
    // Use limit=5000 to get all orders (API defaults to only 20)
    const response = await fetch(`${MTN_API_BASE_URL}/api/orders?limit=5000`, {
      method: "GET",
      headers: {
        "X-API-KEY": MTN_API_KEY,
        "Content-Type": "application/json",
      },
    })

    const responseText = await response.text()
    console.log(`[CRON] Sykes API response status: ${response.status}`)

    if (!response.ok) {
      return {
        success: false,
        orders: [],
        message: `API error: ${response.status} - ${responseText.slice(0, 200)}`,
      }
    }

    let data
    try {
      // Extract JSON from response (strip any PHP warnings/HTML before the JSON)
      const jsonMatch = responseText.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
      if (jsonMatch) {
        data = JSON.parse(jsonMatch[0])
      } else {
        return {
          success: false,
          orders: [],
          message: `No JSON found in response: ${responseText.slice(0, 100)}`,
        }
      }
    } catch {
      return {
        success: false,
        orders: [],
        message: `Invalid JSON response: ${responseText.slice(0, 100)}`,
      }
    }

    // Handle various response formats
    let orders: any[] = []
    if (Array.isArray(data)) {
      orders = data
    } else if (data.data && Array.isArray(data.data)) {
      orders = data.data
    } else if (data.orders && Array.isArray(data.orders)) {
      orders = data.orders
    } else if (data.order) {
      orders = [data.order]
    } else if (data.id) {
      orders = [data]
    }

    console.log(`[CRON] ✅ Fetched ${orders.length} orders from Sykes API`)
    
    // Log some sample orders for debugging
    if (orders.length > 0) {
      console.log(`[CRON] Sample order structure:`, JSON.stringify(orders[0]).slice(0, 300))
      console.log(`[CRON] Order IDs in response:`, orders.slice(0, 20).map((o: any) => `${o.id || o.order_id}:${o.status}`).join(', '))
    }

    return { success: true, orders }
  } catch (error) {
    console.error("[CRON] Error fetching Sykes orders:", error)
    return {
      success: false,
      orders: [],
      message: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Normalize Sykes API status to our expected values
 */
function normalizeStatus(apiStatus: string): "pending" | "processing" | "completed" | "failed" {
  const status = String(apiStatus).toLowerCase().trim()
  
  // Completed variations
  if (status === "completed" || status === "success" || status === "delivered" || 
      status === "done" || status === "fulfilled" || status === "sent" ||
      status === "successful" || status === "complete") {
    return "completed"
  }
  // Failed variations  
  if (status === "failed" || status === "error" || status === "cancelled" ||
      status === "rejected" || status === "expired" || status === "refunded") {
    return "failed"
  }
  // Processing variations
  if (status === "processing" || status === "in_progress" || status === "queued" ||
      status === "in-progress" || status === "sending" || status === "submitted") {
    return "processing"
  }
  // Pending variations
  if (status === "pending" || status === "waiting" || status === "new") {
    return "pending"
  }
  
  console.warn(`[CRON] ⚠️ Unknown status: "${apiStatus}" - defaulting to processing`)
  return "processing"
}

/**
 * Check if MTN auto-fulfillment is enabled in admin_settings
 */
async function isMTNAutoFulfillmentEnabled(): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", "mtn_auto_fulfillment_enabled")
      .maybeSingle()
    
    if (error || !data) {
      // Default to disabled if setting doesn't exist
      return false
    }
    
    // Extract enabled value from JSON object
    return data.value?.enabled === true
  } catch (error) {
    console.warn("[CRON] Error checking MTN auto-fulfillment setting:", error)
    return false
  }
}

/**
 * GET /api/cron/sync-mtn-status
 * 
 * Cron job to sync MTN order statuses from Sykes API.
 * OPTIMIZED: Fetches all orders once and matches locally.
 * Only runs when MTN auto-fulfillment is enabled.
 */
export async function GET(request: NextRequest) {
  try {
    console.log("[CRON] Starting MTN status sync...")

    // Check if MTN auto-fulfillment is enabled
    const mtnEnabled = await isMTNAutoFulfillmentEnabled()
    if (!mtnEnabled) {
      console.log("[CRON] MTN auto-fulfillment is disabled. Skipping sync.")
      return NextResponse.json({
        success: true,
        message: "MTN auto-fulfillment is disabled. Sync skipped.",
        skipped: true,
      })
    }

    // Step 1: Fetch ALL orders from Sykes API in a single call
    const sykesResult = await fetchAllSykesOrders()
    
    if (!sykesResult.success) {
      console.error("[CRON] Failed to fetch Sykes orders:", sykesResult.message)
      return NextResponse.json({ 
        error: "Failed to fetch orders from Sykes API",
        details: sykesResult.message 
      }, { status: 500 })
    }

    // Create a map of Sykes orders for fast lookup (by ID)
    const sykesOrderMap = new Map<string, any>()
    for (const order of sykesResult.orders) {
      const orderId = String(order.id || order.order_id)
      sykesOrderMap.set(orderId, order)
    }
    console.log(`[CRON] Created lookup map with ${sykesOrderMap.size} Sykes orders`)

    // Step 2: Get all pending and processing orders from our database
    const { data: pendingOrders, error: fetchError } = await supabase
      .from("mtn_fulfillment_tracking")
      .select("id, mtn_order_id, status, shop_order_id, order_id, order_type")
      .in("status", ["pending", "processing"])
      .not("mtn_order_id", "is", null)
      .order("created_at", { ascending: true })
      .limit(100) // Can process more since we're not making individual API calls

    if (fetchError) {
      console.error("[CRON] Error fetching pending orders:", fetchError)
      return NextResponse.json({ error: "Failed to fetch orders" }, { status: 500 })
    }

    if (!pendingOrders || pendingOrders.length === 0) {
      console.log("[CRON] No pending/processing orders to sync")
      return NextResponse.json({ 
        success: true, 
        message: "No orders to sync",
        synced: 0,
        sykesOrderCount: sykesResult.orders.length
      })
    }

    console.log(`[CRON] Found ${pendingOrders.length} local orders to sync against ${sykesResult.orders.length} Sykes orders`)

    let synced = 0
    let failed = 0
    let notFound = 0
    const results: Array<{ id: string; mtn_order_id: number; oldStatus: string; newStatus: string | null; error?: string }> = []

    // Step 3: Process each pending order by looking up in the Sykes map
    for (const order of pendingOrders) {
      try {
        // Look up this order in the Sykes order map
        const mtnOrderIdStr = String(order.mtn_order_id)
        const sykesOrder = sykesOrderMap.get(mtnOrderIdStr)

        if (!sykesOrder) {
          console.log(`[CRON] Order ${order.mtn_order_id} not found in Sykes API response`)
          results.push({ 
            id: order.id, 
            mtn_order_id: order.mtn_order_id, 
            oldStatus: order.status, 
            newStatus: null,
            error: "Order not found in Sykes API" 
          })
          notFound++
          continue
        }

        if (!sykesOrder.status) {
          console.log(`[CRON] Order ${order.mtn_order_id} has no status field in Sykes response`)
          results.push({ 
            id: order.id, 
            mtn_order_id: order.mtn_order_id, 
            oldStatus: order.status, 
            newStatus: null,
            error: "No status field in Sykes order" 
          })
          failed++
          continue
        }

        // Normalize the status from Sykes
        const normalizedStatus = normalizeStatus(sykesOrder.status)
        console.log(`[CRON] Order ${order.mtn_order_id}: Sykes "${sykesOrder.status}" -> normalized "${normalizedStatus}"`)

        // If status changed, update the database
        if (normalizedStatus !== order.status) {
          // Update tracking table
          const { error: trackingError } = await supabase
            .from("mtn_fulfillment_tracking")
            .update({
              status: normalizedStatus,
              external_status: sykesOrder.status,
              external_message: sykesOrder.message,
              updated_at: new Date().toISOString(),
            })
            .eq("id", order.id)

          if (trackingError) {
            console.error(`[CRON] ❌ Failed to update tracking for ${order.mtn_order_id}:`, trackingError)
            results.push({ 
              id: order.id, 
              mtn_order_id: order.mtn_order_id, 
              oldStatus: order.status, 
              newStatus: null,
              error: `DB error: ${trackingError.message}`
            })
            failed++
            continue
          }

          // Update corresponding order table and send notification
          let userId: string | null = null
          let orderDetails: { network?: string; size?: string; phone?: string } = {}

          if (order.order_type === "bulk" && order.order_id) {
            const { data: orderData, error: orderError } = await supabase
              .from("orders")
              .update({
                status: normalizedStatus,
                updated_at: new Date().toISOString(),
              })
              .eq("id", order.order_id)
              .select("user_id, network, size, phone_number")
              .single()
            
            if (orderError) {
              console.error(`[CRON] ⚠️ Failed to update bulk order ${order.order_id}:`, orderError)
            } else if (orderData) {
              userId = orderData.user_id
              orderDetails = { network: orderData.network, size: orderData.size, phone: orderData.phone_number }
            }
          } else if (order.shop_order_id) {
            const { data: shopData, error: shopError } = await supabase
              .from("shop_orders")
              .update({
                order_status: normalizedStatus,
                updated_at: new Date().toISOString(),
              })
              .eq("id", order.shop_order_id)
              .select("shop_id, network, volume_gb, customer_phone")
              .single()
            
            if (shopError) {
              console.error(`[CRON] ⚠️ Failed to update shop order ${order.shop_order_id}:`, shopError)
            } else if (shopData) {
              // Get shop owner user_id
              const { data: shopOwner } = await supabase
                .from("user_shops")
                .select("user_id")
                .eq("id", shopData.shop_id)
                .single()
              userId = shopOwner?.user_id || null
              orderDetails = { network: shopData.network, size: `${shopData.volume_gb}GB`, phone: shopData.customer_phone }
            }
          }

          // Send in-app notification for status changes
          if (userId && (normalizedStatus === "completed" || normalizedStatus === "failed")) {
            const notifTitle = normalizedStatus === "completed" 
              ? "Order Delivered Successfully" 
              : "Order Delivery Failed"
            const notifMessage = normalizedStatus === "completed"
              ? `Your MTN ${orderDetails.size || ""} data order to ${orderDetails.phone || "recipient"} has been delivered successfully.`
              : `Your MTN ${orderDetails.size || ""} data order to ${orderDetails.phone || "recipient"} failed. Please contact support.`
            
            const { error: notifError } = await supabase
              .from("notifications")
              .insert({
                user_id: userId,
                title: notifTitle,
                message: notifMessage,
                type: normalizedStatus === "completed" ? "order_completed" : "order_failed",
                reference_id: order.order_id || order.shop_order_id,
                action_url: order.order_type === "bulk" 
                  ? `/dashboard/my-orders?orderId=${order.order_id}` 
                  : `/dashboard/shop/orders`,
                read: false,
              })
            
            if (notifError) {
              console.error(`[CRON] ⚠️ Failed to send notification for order ${order.mtn_order_id}:`, notifError)
            } else {
              console.log(`[CRON] 🔔 Notification sent to user ${userId} for order ${order.mtn_order_id} (${normalizedStatus})`)
            }
          }

          console.log(`[CRON] ✅ Updated order ${order.mtn_order_id}: ${order.status} -> ${normalizedStatus}`)
          results.push({ 
            id: order.id, 
            mtn_order_id: order.mtn_order_id, 
            oldStatus: order.status, 
            newStatus: normalizedStatus 
          })
          synced++
        } else {
          // Status unchanged
          results.push({ 
            id: order.id, 
            mtn_order_id: order.mtn_order_id, 
            oldStatus: order.status, 
            newStatus: order.status 
          })
        }
      } catch (err) {
        console.error(`[CRON] Error processing order ${order.mtn_order_id}:`, err)
        results.push({ 
          id: order.id, 
          mtn_order_id: order.mtn_order_id, 
          oldStatus: order.status, 
          newStatus: null,
          error: err instanceof Error ? err.message : "Unknown error" 
        })
        failed++
      }
    }

    console.log(`[CRON] Sync complete: ${synced} updated, ${failed} failed, ${notFound} not found, ${pendingOrders.length - synced - failed - notFound} unchanged`)

    return NextResponse.json({
      success: true,
      message: `Synced ${pendingOrders.length} orders`,
      total: pendingOrders.length,
      sykesOrderCount: sykesResult.orders.length,
      synced,
      failed,
      notFound,
      unchanged: pendingOrders.length - synced - failed - notFound,
      results,
    })
  } catch (error) {
    console.error("[CRON] Error in sync-mtn-status:", error)
    return NextResponse.json(
      { error: "Internal server error", details: error instanceof Error ? error.message : "" },
      { status: 500 }
    )
  }
}
