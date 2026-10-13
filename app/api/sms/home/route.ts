import { NextRequest, NextResponse } from "next/server"
import { resolveAccount } from "@/lib/sms/tenant-auth"
import { getHomeSummary } from "@/lib/sms/customer-reads"

// GET /api/sms/home — mode, send limits, 30-day stats, recent credit activity, kill-switch state.
// Read-only: deliberately not kill-switched.
export async function GET(request: NextRequest) {
  const auth = await resolveAccount(request)
  if (auth.error) return auth.error
  try {
    return NextResponse.json({ success: true, data: await getHomeSummary(auth.account.id) })
  } catch (e) {
    console.error("[SMS-HOME] Error:", e)
    return NextResponse.json({ success: false, error: "Couldn't load your SMS summary, try again." }, { status: 500 })
  }
}
