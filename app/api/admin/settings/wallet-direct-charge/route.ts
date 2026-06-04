import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { invalidateWalletDirectChargeCache } from "@/lib/storefront-otp"

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
    const { data, error } = await supabase
      .from("admin_settings")
      .select("key, value, updated_at")
      .eq("key", "wallet_direct_charge")
      .maybeSingle()

    if (error) {
      console.error("[WALLET-DIRECT-CHARGE-SETTINGS] Read error:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      enabled: data?.value?.enabled === true,
      updated_at: data?.updated_at ?? null,
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

    const { error } = await supabase
      .from("admin_settings")
      .upsert({
        key: "wallet_direct_charge",
        value: { enabled },
        description: "Collect order-free payments (wallet top-up + dealer upgrade) via an on-page direct MoMo charge (live prompt modal) instead of the hosted Paystack redirect. Independent of the wallet OTP gate.",
        updated_at: new Date().toISOString(),
      }, { onConflict: "key" })

    if (error) {
      console.error("[WALLET-DIRECT-CHARGE-SETTINGS] Upsert error:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    invalidateWalletDirectChargeCache()
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
