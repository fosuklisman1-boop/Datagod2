import { NextRequest, NextResponse } from "next/server"
import { atishareService } from "@/lib/at-ishare-service"

/**
 * API endpoint to check scheduled orders for status updates
 * Can be called manually or triggered by dashboard load
 */
export async function GET(request: NextRequest) {
  try {
    console.log("[CHECK-ORDERS] Checking scheduled orders for status updates...")

    const result = await atishareService.checkScheduledOrders()

    return NextResponse.json({
      success: true,
      message: `Checked ${result.checked} orders, updated ${result.updated}`,
      ...result,
    })
  } catch (error) {
    console.error("[CHECK-ORDERS] Error:", error)
    return NextResponse.json(
      { error: "Failed to check orders", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  // Same as GET, for flexibility
  return GET(request)
}
