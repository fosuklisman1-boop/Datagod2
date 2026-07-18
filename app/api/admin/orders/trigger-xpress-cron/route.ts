import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

/**
 * POST /api/admin/orders/trigger-xpress-cron
 * Admin-gated proxy that fires the Xpress status-sync cron with the server-side secret.
 */
export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 })
  }

  const cronUrl = new URL("/api/cron/sync-mtn-status/xpress", request.url).toString()

  const res = await fetch(cronUrl, {
    headers: { Authorization: `Bearer ${cronSecret}` },
  })

  const json = await res.json().catch(() => ({}))
  return NextResponse.json(json, { status: res.status })
}
