import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { pollSenderIds } from "@/lib/sms/sender-id-service"

// GET /api/cron/sms-senderid-poll — scheduled reconciliation of pending sender IDs.
// Gated by verifyAdminAccess, which accepts the CRON_SECRET bearer token.
export async function GET(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  const result = await pollSenderIds()
  if (!result.ok) {
    console.error("[CRON-SENDERID-POLL]", result.error)
    return NextResponse.json({ success: false, error: result.error }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: result.data })
}
