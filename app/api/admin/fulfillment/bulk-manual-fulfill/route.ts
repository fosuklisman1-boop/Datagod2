import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { processManualFulfillment } from "@/lib/fulfillment-service"

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
    const { orderIds, order_type = "shop", provider } = body

    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return NextResponse.json({ error: "orderIds array is required" }, { status: 400 })
    }

    console.log(`[BULK-MANUAL-FULFILL] Processing ${orderIds.length} orders...`)

    const results = []
    let successCount = 0
    let failureCount = 0

    // Process orders sequentially to avoid overwhelming the provider or database
    // and for better error tracking per order.
    for (const orderId of orderIds) {
      try {
        const result = await processManualFulfillment(orderId, order_type as "shop" | "bulk", provider)
        results.push(result)
        if (result.success) {
          successCount++
        } else {
          failureCount++
        }
      } catch (error) {
        console.error(`[BULK-MANUAL-FULFILL] Uncaught error for order ${orderId}:`, error)
        failureCount++
        results.push({
          success: false,
          message: error instanceof Error ? error.message : "Internal error",
          orderId
        })
      }
    }

    return NextResponse.json({
      success: true,
      message: `Processed ${orderIds.length} orders: ${successCount} succeeded, ${failureCount} failed.`,
      summary: {
        total: orderIds.length,
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
