import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createMTNOrder, saveMTNTracking, MTNOrderRequest } from "@/lib/mtn-fulfillment"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { isPhoneBlacklisted } from "@/lib/blacklist"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { notifyAdminsPush } from "@/lib/push-service"

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

    // USSD orders have their own fulfillment path — bypass auto-fulfillment setting check
    if (order_type === "ussd" || order_type === "ussd_shop") {
      const table = order_type === "ussd_shop" ? "ussd_shop_orders" : "ussd_orders"
      const { data: ussdOrder, error: fetchErr } = await supabase
        .from(table)
        .select("id, network, recipient_phone, package_size, order_status")
        .eq("id", shop_order_id)
        .single()

      if (fetchErr || !ussdOrder) {
        return NextResponse.json({ error: "USSD order not found" }, { status: 404 })
      }

      const { fulfillUssdOrder } = await import("@/lib/ussd/fulfill")
      const result = await fulfillUssdOrder(
        ussdOrder.id,
        ussdOrder.network,
        ussdOrder.recipient_phone,
        ussdOrder.package_size ?? "",
        true, // forceManual — bypass auto-fulfillment setting check
        table
      )

      if (result.success) {
        notifyAdminsPush({
          title: '📦 USSD Order Fulfilled',
          body: `Manual fulfillment sent for ${ussdOrder.network} order #${String(shop_order_id).slice(0, 8)}`,
          data: { url: '/admin/orders' },
        }).catch(() => {})
      }
      return NextResponse.json({
        success: result.success,
        message: result.message,
      }, { status: result.success ? 200 : 400 })
    }

    const { processManualFulfillment } = await import("@/lib/fulfillment-service")

    const result = await processManualFulfillment(shop_order_id, order_type as "shop" | "bulk", provider)

    if (!result.success) {
      return NextResponse.json({ error: result.message }, { status: 400 })
    }

    notifyAdminsPush({
      title: '📦 Order Fulfilled',
      body: `Manual fulfillment queued for ${order_type} order #${String(shop_order_id).slice(0, 8)}`,
      data: { url: '/admin/orders' },
    }).catch(() => {})

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

    // 3. Fetch USSD orders (paid but awaiting fulfillment)
    const { data: ussdOrders, count: ussdCount, error: ussdError } = await supabase
      .from("ussd_orders")
      .select("id, network, package_size, recipient_phone, dialing_phone, order_status, created_at, amount", { count: "exact" })
      .in("network", ["MTN", "Telecel", "AirtelTigo", "AT-iShare"])
      .eq("payment_status", "completed")
      .eq("order_status", "pending")
      .order("created_at", { ascending: false })

    if (ussdError) {
      console.error("[MANUAL-FULFILL] ussd_orders fetch error:", ussdError)
    }

    // 4. Fetch USSD shop orders (paid but awaiting fulfillment)
    const { data: ussdShopOrders, count: ussdShopCount, error: ussdShopError } = await supabase
      .from("ussd_shop_orders")
      .select("id, network, package_size, recipient_phone, dialing_phone, order_status, created_at, amount, shop_name", { count: "exact" })
      .in("network", allowedNetworks)
      .eq("payment_status", "completed")
      .eq("order_status", "pending")
      .order("created_at", { ascending: false })

    if (ussdShopError) {
      console.error("[MANUAL-FULFILL] ussd_shop_orders fetch error:", ussdShopError)
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

    const mappedUssd = (ussdOrders || []).map(o => ({
      id: o.id,
      network: o.network,
      volume_gb: o.package_size,
      customer_phone: o.recipient_phone,
      dialing_phone: o.dialing_phone,
      customer_name: "USSD Order",
      order_status: o.order_status,
      created_at: o.created_at,
      type: "ussd"
    }))

    const mappedUssdShop = (ussdShopOrders || []).map(o => ({
      id: o.id,
      network: o.network,
      volume_gb: o.package_size,
      customer_phone: o.recipient_phone,
      dialing_phone: o.dialing_phone,
      customer_name: o.shop_name ? `USSD Shop (${o.shop_name})` : "USSD Shop Order",
      order_status: o.order_status,
      created_at: o.created_at,
      type: "ussd_shop"
    }))

    // Combine and sort by date
    const allOrders = [...mappedShop, ...mappedBulk, ...mappedUssd, ...mappedUssdShop].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )

    const totalCount = (shopCount || 0) + (bulkCount || 0) + (ussdCount || 0) + (ussdShopCount || 0)
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
