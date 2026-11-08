import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { refundDb, refundErrorResponse } from "@/lib/refunds/http"
import { listHubtelWalletAttention } from "@/lib/refunds/hubtel-wallet"

/**
 * Hubtel main-code wallet payments an admin must see on /admin/refunds (needs_review, or still debited after the sweep
 * window), whatever happened to the SMS alert. Read-only.
 */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse ?? NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  try {
    return NextResponse.json({ rows: await listHubtelWalletAttention(refundDb()) })
  } catch (err) {
    return refundErrorResponse(err)
  }
}
