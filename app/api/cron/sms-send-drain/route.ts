import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { drainSmsMessages } from "@/lib/sms/send-drain"

/**
 * Drain queued sms_messages rows — claim, send, update status.
 * Runs every minute via vercel.json cron. Auth via CRON_SECRET or admin Bearer token.
 */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const summary = await drainSmsMessages({ limit: 200 })
    return NextResponse.json({ success: true, data: summary })
  } catch (e: any) {
    console.error("[CRON-SMS-DRAIN] Error:", e)
    return NextResponse.json({ success: false, error: e?.message ?? "Internal error" }, { status: 500 })
  }
}
