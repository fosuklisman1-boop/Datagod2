import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getGatewayConfig } from "@/lib/payment-gateway/read-config"
import { setSurfaceModes } from "@/lib/payment-gateway/write-config"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * GET /api/admin/settings/wallet-direct-charge → current state
 *
 * Controls whether the order-free payment paths (wallet top-up + dealer upgrade)
 * are collected via an on-page direct MoMo charge (live prompt modal) instead of
 * the hosted Paystack redirect. Independent of the wallet OTP gate. When the row
 * is absent the reader inherits the wallet OTP gate's value (see lib/storefront-otp).
 */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const config = await getGatewayConfig()
    return NextResponse.json({
      success: true,
      enabled: config.surfaces.wallet_topup.mode === "direct",
      updated_at: null,
    })
  } catch (e) {
    console.error("[WALLET-DIRECT-CHARGE-SETTINGS] GET error:", e)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

/**
 * POST /api/admin/settings/wallet-direct-charge  { enabled: boolean }
 */
export async function POST(request: NextRequest) {
  const { isAdmin, userId, userEmail, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { enabled } = await request.json()
    if (typeof enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 })
    }

    try {
      await setSurfaceModes(supabase, ["wallet_topup", "dashboard_direct", "sms"], enabled ? "direct" : "checkout", userEmail ?? userId ?? "unknown")
    } catch (err) {
      console.error("[WALLET-DIRECT-CHARGE-SETTINGS] Save error:", err)
      return NextResponse.json({ error: err instanceof Error ? err.message : "Save failed" }, { status: 500 })
    }

    console.warn(`[WALLET-DIRECT-CHARGE-SETTINGS] ⚠️ Wallet/upgrade direct MoMo charge is now ${enabled ? "ENABLED" : "DISABLED"} (by ${userEmail ?? userId})`)
    return NextResponse.json({
      success: true,
      enabled,
      message: `Wallet & upgrade direct MoMo charge is now ${enabled ? "ON" : "OFF"}`,
    })
  } catch (e) {
    console.error("[WALLET-DIRECT-CHARGE-SETTINGS] POST error:", e)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
