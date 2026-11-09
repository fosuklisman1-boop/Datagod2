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
 * GET /api/admin/settings/storefront-direct-charge → current state
 *
 * Controls whether storefront shop-order payments are collected via an on-page
 * direct MoMo charge (the live "approve the prompt" modal) instead of the hosted
 * Paystack redirect. Independent of the storefront OTP gate. When the row is
 * absent the reader inherits the OTP gate's value (see lib/storefront-otp).
 */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const config = await getGatewayConfig()
    return NextResponse.json({
      success: true,
      enabled: config.surfaces.storefront.mode === "direct",
      updated_at: null,
    })
  } catch (e) {
    console.error("[STOREFRONT-DIRECT-CHARGE-SETTINGS] GET error:", e)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

/**
 * POST /api/admin/settings/storefront-direct-charge  { enabled: boolean }
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
      await setSurfaceModes(supabase, ["storefront"], enabled ? "direct" : "checkout", userEmail ?? userId ?? "unknown")
    } catch (err) {
      console.error("[STOREFRONT-DIRECT-CHARGE-SETTINGS] Save error:", err)
      return NextResponse.json({ error: err instanceof Error ? err.message : "Save failed" }, { status: 500 })
    }

    console.warn(`[STOREFRONT-DIRECT-CHARGE-SETTINGS] ⚠️ Storefront direct MoMo charge is now ${enabled ? "ENABLED" : "DISABLED"} (by ${userEmail ?? userId})`)
    return NextResponse.json({
      success: true,
      enabled,
      message: `Storefront direct MoMo charge is now ${enabled ? "ON" : "OFF"}`,
    })
  } catch (e) {
    console.error("[STOREFRONT-DIRECT-CHARGE-SETTINGS] POST error:", e)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
