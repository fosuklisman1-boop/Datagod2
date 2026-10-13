import { NextRequest, NextResponse } from "next/server"
import { adminGuard } from "@/lib/sms/admin-guard"
import { resolveHubtelBalance } from "@/lib/sms/wholesale"
import { getAdminSettings } from "@/lib/sms/admin-settings"
import { isManualBalanceFresh } from "@/lib/sms/hubtel-manual-balance"
import { fetchDisbursementBalance } from "@/lib/ussd-hubtel/relay"

// GET — the Hubtel balance the solvency gate would use right now (`current`: relay, else manual
// estimate, else unavailable — or ONLY the manual estimate when prefer-manual is on), the stored manual
// balance, the prefer-manual flag, and the raw relay reading (`relay`) as information only: the relay
// reads the Disbursement wallet, which may not be the wallet Hubtel SMS is paid from.
// Read-only; writes go through PATCH /settings (section hubtel_manual_balance).
export async function GET(request: NextRequest) {
  const g = await adminGuard(request)
  if (!g.ok) return g.response
  try {
    const [current, admin, relay] = await Promise.all([resolveHubtelBalance(), getAdminSettings(), fetchDisbursementBalance()])
    const mb = admin.settings.hubtelManualBalance
    return NextResponse.json({
      success: true,
      data: {
        current,
        manual: mb ? { ...mb, fresh: isManualBalanceFresh(mb) } : null,
        preferManual: admin.settings.hubtelPreferManualBalance === true,
        relay,
      },
    })
  } catch (e) {
    console.error("[SMS-ADMIN] hubtel balance load failed:", e)
    return NextResponse.json({ success: false, error: "Could not load the Hubtel balance" }, { status: 500 })
  }
}
