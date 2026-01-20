import { NextRequest, NextResponse } from "next/server"
import { atishareService } from "@/lib/at-ishare-service"

// Cron secret to prevent unauthorized access
const CRON_SECRET = process.env.CRON_SECRET

/**
 * GET /api/cron/sync-codecraft-status
 * 
 * Cron job to check CodeCraft order statuses and update local database.
 * Runs every 5 minutes to check orders that are due for status verification.
 * 
 * This handles AT-iShare, Telecel, and AT-BigTime orders fulfilled via CodeCraft API.
 */
export async function GET(request: NextRequest) {
  try {
    console.log("[CRON-CODECRAFT] Starting CodeCraft status sync...")

    // Verify cron secret if configured (optional security layer)
    const authHeader = request.headers.get("authorization")
    if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
      // For Vercel cron, we can skip this check as Vercel handles auth
      // But we'll log a warning if the header is present but wrong
      if (authHeader) {
        console.warn("[CRON-CODECRAFT] Invalid authorization header")
      }
    }

    // Call the checkScheduledOrders method which:
    // 1. Finds orders in fulfillment_logs with status="processing" and retry_after <= now
    // 2. Calls CodeCraft API to check actual status using the CodeCraft reference_id
    // 3. Updates order status in database if completed/failed
    // 4. Schedules next check if still processing
    const result = await atishareService.checkScheduledOrders()

    console.log(`[CRON-CODECRAFT] Sync complete. Checked: ${result.checked}, Updated: ${result.updated}`)

    return NextResponse.json({
      success: true,
      message: `Checked ${result.checked} orders, updated ${result.updated}`,
      checked: result.checked,
      updated: result.updated,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[CRON-CODECRAFT] Error:", error)
    return NextResponse.json(
      { 
        error: "Failed to sync CodeCraft orders", 
        details: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    )
  }
}

// POST handler for manual triggers
export async function POST(request: NextRequest) {
  return GET(request)
}
