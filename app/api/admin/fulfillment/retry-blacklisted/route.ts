import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { isPhoneBlacklisted } from "@/lib/blacklist"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * POST /api/admin/fulfillment/retry-blacklisted
 * Retry fulfillment for orders that were previously blacklisted but are now cleared
 */
export async function POST(request: NextRequest) {
  try {
    // Verify admin access
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) {
      return errorResponse
    }

    const body = await request.json()
    const { order_id, order_type = "shop" } = body

    console.log(`[RETRY-BLACKLISTED] Admin retrying fulfillment for blacklisted order (${order_type}):`, order_id)

    // Determine which table to query
    const tableName = order_type === "bulk" ? "orders" : "shop_orders"

    // Fetch order details
    let orderData: any
    let fetchError: any

    if (order_type === "bulk") {
      const response = await supabase
        .from(tableName)
        .select("id, network, size, phone_number, status, queue")
        .eq("id", order_id)
        .single()
      orderData = response.data
      fetchError = response.error
      // Map bulk fields to common names
      if (orderData) {
        orderData.volume_gb = orderData.size
        orderData.order_status = orderData.status
        orderData.customer_phone = orderData.phone_number
      }
    } else {
      const response = await supabase
        .from(tableName)
        .select("id, network, volume_gb, customer_phone, customer_name, order_status, queue")
        .eq("id", order_id)
        .single()
      orderData = response.data
      fetchError = response.error
    }

    if (fetchError || !orderData) {
      console.error(`[RETRY-BLACKLISTED] Failed to fetch order:`, fetchError)
      return NextResponse.json(
        { error: `Order not found in ${tableName}` },
        { status: 404 }
      )
    }

    // Check if order is still in blacklist queue
    if (orderData.queue !== "blacklisted") {
      return NextResponse.json(
        { error: `Order is not in blacklist queue (current: ${orderData.queue})` },
        { status: 400 }
      )
    }

    // Check if phone is still blacklisted
    const phone = orderData.customer_phone || orderData.phone_number
    const isStillBlacklisted = await isPhoneBlacklisted(phone)

    if (isStillBlacklisted) {
      console.log(`[RETRY-BLACKLISTED] Phone ${phone} is still blacklisted`)
      return NextResponse.json(
        { error: `Phone ${phone} is still blacklisted. Remove from blacklist first.` },
        { status: 400 }
      )
    }

    // Phone is no longer blacklisted - update order queue to "default"
    console.log(`[RETRY-BLACKLISTED] Phone ${phone} is now cleared. Updating order queue...`)

    const { error: updateError } = await supabase
      .from(tableName)
      .update({
        queue: "default",
        updated_at: new Date().toISOString(),
      })
      .eq("id", order_id)

    if (updateError) {
      console.error(`[RETRY-BLACKLISTED] Failed to update order queue:`, updateError)
      return NextResponse.json(
        { error: "Failed to update order queue" },
        { status: 500 }
      )
    }

    console.log(`[RETRY-BLACKLISTED] ✓ Order ${order_id} queue updated to 'default'. Ready for re-fulfillment.`)

    return NextResponse.json({
      success: true,
      message: `Order ${order_id} is now cleared from blacklist. It will be processed on next fulfillment cycle.`,
      phone_cleared: phone,
      new_queue: "default",
    })
  } catch (error) {
    console.error("[RETRY-BLACKLISTED] Error:", error)
    return NextResponse.json(
      { error: "Failed to retry fulfillment", details: error instanceof Error ? error.message : "" },
      { status: 500 }
    )
  }
}

/**
 * GET /api/admin/fulfillment/retry-blacklisted
 * Get list of orders currently in blacklist queue
 */
export async function GET(request: NextRequest) {
  try {
    // Verify admin access
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) {
      return errorResponse
    }

    const searchParams = request.nextUrl.searchParams
    const orderType = searchParams.get("type") || "shop" // "shop" or "bulk"
    const page = parseInt(searchParams.get("page") || "1")
    const limit = Math.min(parseInt(searchParams.get("limit") || "100"), 500) // Max 500 per page
    const offset = (page - 1) * limit

    console.log(`[RETRY-BLACKLISTED] Fetching blacklisted orders (${orderType})...`)

    const tableName = orderType === "bulk" ? "orders" : "shop_orders"
    const columns = orderType === "bulk"
      ? "id, network, size, phone_number, status, created_at, updated_at"
      : "id, network, volume_gb, customer_phone, customer_name, order_status, created_at, updated_at"

    // Get total count
    const { count } = await supabase
      .from(tableName)
      .select("*", { count: "exact", head: true })
      .eq("queue", "blacklisted")

    // Get paginated results
    const { data: blacklistedOrders, error } = await supabase
      .from(tableName)
      .select(columns)
      .eq("queue", "blacklisted")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) {
      console.error(`[RETRY-BLACKLISTED] Failed to fetch blacklisted orders:`, error)
      return NextResponse.json(
        { error: "Failed to fetch blacklisted orders" },
        { status: 500 }
      )
    }

    // Check which phones are still blacklisted vs cleared
    const ordersWithStatus = await Promise.all(
      (blacklistedOrders || []).map(async (order: any) => {
        const phone = orderType === "bulk" ? order.phone_number : order.customer_phone
        const isStillBlacklisted = await isPhoneBlacklisted(phone)
        return {
          ...order,
          phone,
          is_still_blacklisted: isStillBlacklisted,
          can_retry: !isStillBlacklisted,
        }
      })
    )

    const readyToRetry = ordersWithStatus.filter((o: any) => o.can_retry)
    const stillBlacklisted = ordersWithStatus.filter((o: any) => !o.can_retry)

    console.log(`[RETRY-BLACKLISTED] Found ${readyToRetry.length} cleared, ${stillBlacklisted.length} still blacklisted`)

    return NextResponse.json({
      success: true,
      orderType,
      orders: ordersWithStatus,
      stats: {
        ready_to_retry: readyToRetry.length,
        still_blacklisted: stillBlacklisted.length,
      },
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    })
  } catch (error) {
    console.error("[RETRY-BLACKLISTED] Error:", error)
    return NextResponse.json(
      { error: "Failed to fetch blacklisted orders", details: error instanceof Error ? error.message : "" },
      { status: 500 }
    )
  }
}
