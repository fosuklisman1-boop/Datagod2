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
    const limit = Math.min(parseInt(searchParams.get("limit") || "100"), 500) // Max 500 per page
    const offset = (page - 1) * limit

    // Get total count
    const { count } = await supabase
      .from("shop_orders")
      .select("*", { count: "exact", head: true })
      .eq("network", "MTN")
      .eq("order_status", "pending_download")

    // Get pending MTN orders with pagination
    const { data: orders, error } = await supabase
      .from("shop_orders")
      .select(
        `
        id,
        network,
        volume_gb,
        customer_phone,
        customer_name,
        customer_email,
        order_status,
        fulfillment_method,
        created_at,
        updated_at
      `
      )
      .eq("network", "MTN")
      .eq("order_status", "pending_download")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) {
      console.error("[MANUAL-FULFILL] Failed to fetch pending orders:", error)
      return NextResponse.json({ error: "Failed to fetch orders" }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      orders: orders || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
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
