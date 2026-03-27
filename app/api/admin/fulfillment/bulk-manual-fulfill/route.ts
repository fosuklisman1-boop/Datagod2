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
    const { orders, provider } = body

    if (!orders || !Array.isArray(orders) || orders.length === 0) {
      return NextResponse.json({ error: "orders array (with id and type) is required" }, { status: 400 })
    }

    console.log(`[BULK-MANUAL-FULFILL] Processing ${orders.length} orders...`)

    const results = []
    let successCount = 0
    let failureCount = 0

    for (const orderInfo of orders) {
      const { id, type } = orderInfo
      try {
        const result = await processManualFulfillment(id, (type || "shop") as "shop" | "bulk" | "api", provider)
        results.push(result)
        if (result.success) {
          successCount++
        } else {
          failureCount++
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
