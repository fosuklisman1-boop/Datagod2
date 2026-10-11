import { NextRequest, NextResponse } from "next/server"
import { adminGuard } from "@/lib/sms/admin-guard"
import { resolveHubtelBalance } from "@/lib/sms/wholesale"
import { getAdminSettings } from "@/lib/sms/admin-settings"
import { isManualBalanceFresh } from "@/lib/sms/hubtel-manual-balance"

// GET — the Hubtel balance the solvency gate would use right now (relay, else manual estimate, else
// unavailable) plus the stored manual balance, for Settings → "Hubtel balance (manual fallback)".
// Read-only; the manual balance itself is written through PATCH /settings (section hubtel_manual_balance).
export async function GET(request: NextRequest) {
  const g = await adminGuard(request)
  if (!g.ok) return g.response
  try {
    const [current, admin] = await Promise.all([resolveHubtelBalance(), getAdminSettings()])
    const mb = admin.settings.hubtelManualBalance
    return NextResponse.json({
      success: true,
      data: { current, manual: mb ? { ...mb, fresh: isManualBalanceFresh(mb) } : null },
    })
  } catch (e) {
    console.error("[SMS-ADMIN] hubtel balance load failed:", e)
    return NextResponse.json({ success: false, error: "Could not load the Hubtel balance" }, { status: 500 })
  }
}
