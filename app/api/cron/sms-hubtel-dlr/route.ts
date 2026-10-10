import { NextRequest, NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { pollHubtelDeliveries } from "@/lib/sms/delivery-poll"

export const maxDuration = 300

/** Poll Hubtel delivery reports, refund failures once, close 72 h stragglers. Every 2 min. */
export async function GET(request: NextRequest) {
  const auth = verifyCronAuth(request)
  if (!auth.authorized) return auth.errorResponse!
  try {
    const summary = await pollHubtelDeliveries({ deadlineMs: Date.now() + 240_000 })
    if (summary.errors > 0) {
      return NextResponse.json({ success: false, error: `${summary.errors} error(s) during DLR poll`, data: summary }, { status: 500 })
    }
    return NextResponse.json({ success: true, data: summary })
  } catch (e) {
    console.error("[CRON-SMS-DLR-HUBTEL] Error:", e)
    return NextResponse.json({ success: false, error: (e as Error)?.message ?? "Internal error" }, { status: 500 })
  }
}
