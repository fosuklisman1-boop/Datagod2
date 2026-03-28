import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createMTNOrder, saveMTNTracking, MTNOrderRequest } from "@/lib/mtn-fulfillment"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { isPhoneBlacklisted } from "@/lib/blacklist"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * POST /api/admin/fulfillment/manual-fulfill
 * Admin manually triggers fulfillment for queued MTN orders
 */
export async function POST(request: NextRequest) {
  try {
    // Verify admin access
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) {
      return errorResponse
    }

    const body = await request.json()
    const { shop_order_id, order_type = "shop", provider } = body

    if (!shop_order_id) {
      return NextResponse.json({ error: "shop_order_id is required" }, { status: 400 })
    }

    const { processManualFulfillment } = await import("@/lib/fulfillment-service")
    
    const result = await processManualFulfillment(shop_order_id, order_type as "shop" | "bulk", provider)

    if (!result.success) {
      return NextResponse.json({ error: result.message }, { status: 400 })
    }

    return NextResponse.json({
      success: true,
      message: result.message,
      mtn_order_id: result.mtnOrderId,
      tracking_id: result.trackingId,
    })
  } catch (error) {
    console.error("[MANUAL-FULFILL] Error:", error)
    return NextResponse.json(
      { error: "Fulfillment failed", details: error instanceof Error ? error.message : "" },
      { status: 500 }
    )
  }
}

/**
 * GET /api/admin/fulfillment/manual-fulfill
 * List pending MTN orders awaiting manual fulfillment
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const page = parseInt(searchParams.get("page") || "1")
    const limit = Math.min(parseInt(searchParams.get("limit") || "100"), 500)
    const offset = (page - 1) * limit

    const statuses = ["pending", "pending_download"]
    const allowedNetworks = [
      "MTN", 
      "AT - iShare", "AT-iShare", "AT - ishare", "at - ishare", "AT - ISHARE", "AT-ISHARE",
      "Telecel", "telecel", "TELECEL",
      "AT - BigTime", "AT-BigTime", "AT - bigtime", "at - bigtime", "AT - BIGTIME", "AT-BIGTIME"
    ]

    // 1. Fetch from shop_orders
    const { data: shopOrders, count: shopCount, error: shopError } = await supabase
      .from("shop_orders")
      .select("id, network, volume_gb, customer_phone, customer_name, customer_email, order_status, created_at, payment_status", { count: "exact" })
      .in("network", allowedNetworks)
      .eq("payment_status", "completed")
      .in("order_status", statuses)
      .order("created_at", { ascending: false })

    if (shopError) {
      console.error("[MANUAL-FULFILL] shop_orders fetch error:", shopError)
    }

    // 2. Fetch from orders (bulk orders)
    const { data: bulkOrders, count: bulkCount, error: bulkError } = await supabase
      .from("orders")
      .select("id, network, size, phone_number, status, created_at, payment_status", { count: "exact" })
      .in("network", allowedNetworks)
      .eq("payment_status", "completed")
      .in("status", statuses)
      .order("created_at", { ascending: false })

    if (bulkError) {
      console.error("[MANUAL-FULFILL] orders fetch error:", bulkError)
    }

    // Map bulk orders to common structure
    const mappedBulk = (bulkOrders || []).map(o => ({
      id: o.id,
      network: o.network,
      volume_gb: o.size,
      customer_phone: o.phone_number,
      customer_name: "Bulk Order",
      order_status: o.status,
      created_at: o.created_at,
      type: "bulk"
    }))

    const mappedShop = (shopOrders || []).map(o => ({
      ...o,
      type: "shop"
    }))

    // Combine and sort by date
    const allOrders = [...mappedShop, ...mappedBulk].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )

    const totalCount = (shopCount || 0) + (bulkCount || 0)
    const paginatedOrders = allOrders.slice(offset, offset + limit)

    return NextResponse.json({
      success: true,
      orders: paginatedOrders,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit),
      },
    })
  } catch (error) {
    console.error("[MANUAL-FULFILL] Error:", error)
    return NextResponse.json(
      { error: "Failed to fetch pending orders" },
      { status: 500 }
    )
  }
}
