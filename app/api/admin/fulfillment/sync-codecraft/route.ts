import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { atishareService } from "@/lib/at-ishare-service"

/**
 * POST /api/admin/fulfillment/sync-codecraft
 * Manually trigger a CodeCraft status sync (same logic as the cron job).
 * Checks fulfillment_logs rows with status="processing" that are due for
 * re-verification, calls the CodeCraft API, and updates local state.
 */
export async function POST(request: NextRequest) {
  try {
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) return errorResponse

    console.log("[SYNC-CODECRAFT] Manual sync triggered by admin")

    const result = await atishareService.checkScheduledOrders()

    console.log(`[SYNC-CODECRAFT] Done. Checked: ${result.checked}, Updated: ${result.updated}`)

    return NextResponse.json({
      success: true,
      message: `Checked ${result.checked} order${result.checked !== 1 ? "s" : ""}, updated ${result.updated}`,
      checked: result.checked,
      updated: result.updated,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[SYNC-CODECRAFT] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to sync CodeCraft orders",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}
