// Hourly self-heal for the MTN registration gate (Phase 2): releases any
// held_registration order whose beneficiary number is now 'registered' in
// mtn_number_registry. Primary release is the mark-registered push; this
// sweep catches crashes mid-release and out-of-band registrations.
import { NextRequest, NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { releaseHeldMtnOrders } from "@/lib/mtn-hold"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!

  try {
    const result = await releaseHeldMtnOrders()
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    console.error("[CRON][RELEASE-HELD-MTN] error:", error)
    return NextResponse.json({ error: "release sweep failed" }, { status: 500 })
  }
}
