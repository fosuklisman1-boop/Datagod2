import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { processManualFulfillment } from "@/lib/fulfillment-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * POST /api/admin/fulfillment/bulk-manual-fulfill
 * Admin manually triggers fulfillment for a batch of queued MTN orders
 */
export async function POST(request: NextRequest) {
  try {
    // Verify admin access
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) {
      return errorResponse
    }

    const body = await request.json()
    const { orders, provider } = body

    if (!orders || !Array.isArray(orders) || orders.length === 0) {
      return NextResponse.json({ error: "orders array (with id and type) is required" }, { status: 400 })
    }

    if (orders.length > 100) {
      return NextResponse.json({ error: "Bulk fulfillment is limited to 100 orders per batch" }, { status: 400 })
    }

    console.log(`[BULK-MANUAL-FULFILL] Processing ${orders.length} orders...`)

    const { fulfillUssdOrder } = await import("@/lib/ussd/fulfill")

    const results = []
    let successCount = 0
    let failureCount = 0

    for (const orderInfo of orders) {
      const { id, type } = orderInfo
      try {
        if (type === "ussd" || type === "ussd_shop") {
          const table = type === "ussd_shop" ? "ussd_shop_orders" : "ussd_orders"
          const { data: ussdOrder, error: fetchErr } = await supabase
            .from(table)
            .select("id, network, recipient_phone, package_size, order_status")
            .eq("id", id)
            .single()

          if (fetchErr || !ussdOrder) {
            failureCount++
            results.push({ success: false, message: "USSD order not found", orderId: id })
            continue
          }

          const result = await fulfillUssdOrder(
            ussdOrder.id,
            ussdOrder.network,
            ussdOrder.recipient_phone,
            ussdOrder.package_size ?? "",
            true,
            table
          )
          results.push({ ...result, orderId: id })
          if (result.success) { successCount++ } else { failureCount++ }
        } else {
          const result = await processManualFulfillment(id, (type || "shop") as "shop" | "bulk" | "api", provider, true)
          results.push(result)
          if (result.success) { successCount++ } else { failureCount++ }
        }
      } catch (error) {
        console.error(`[BULK-MANUAL-FULFILL] Uncaught error for order ${id}:`, error)
        failureCount++
        results.push({
          success: false,
          message: error instanceof Error ? error.message : "Internal error",
          orderId: id
        })
      }
    }

    return NextResponse.json({
      success: true,
      message: `Processed ${orders.length} orders: ${successCount} succeeded, ${failureCount} failed.`,
      summary: {
        total: orders.length,
        success: successCount,
        failed: failureCount
      },
      results
    })

  } catch (error) {
    console.error("[BULK-MANUAL-FULFILL] Critical error:", error)
    return NextResponse.json(
      { error: "Bulk fulfillment operation failed", details: error instanceof Error ? error.message : "" },
      { status: 500 }
    )
  }
}
