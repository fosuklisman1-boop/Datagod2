import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { invalidateWalletOtpCache } from "@/lib/storefront-otp"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * GET /api/admin/settings/wallet-otp → current state (default off)
 *
 * Controls the lockdown of the ORDER-FREE payment paths (wallet top-up + dealer
 * upgrade). Independent of the storefront checkout OTP gate.
 */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { data, error } = await supabase
      .from("admin_settings")
      .select("key, value, updated_at")
      .eq("key", "wallet_otp_required")
      .maybeSingle()

    if (error) {
      console.error("[WALLET-OTP-SETTINGS] Read error:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      enabled: data?.value?.enabled === true,
      updated_at: data?.updated_at ?? null,
    })
  } catch (e) {
    console.error("[WALLET-OTP-SETTINGS] GET error:", e)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

/**
 * POST /api/admin/settings/wallet-otp  { enabled: boolean }
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
        key: "wallet_otp_required",
        value: { enabled },
        description: "Lock down the order-free payment paths (wallet top-up + dealer upgrade): drops the Mobile Money channel + caps per user. Stops MoMo prompt-spam launched from those hosted checkouts. Enable during attacks.",
        updated_at: new Date().toISOString(),
      }, { onConflict: "key" })

    if (error) {
      console.error("[WALLET-OTP-SETTINGS] Upsert error:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    invalidateWalletOtpCache()
    console.warn(`[WALLET-OTP-SETTINGS] ⚠️ Wallet/upgrade payment lock is now ${enabled ? "ENABLED" : "DISABLED"} (by ${userEmail ?? userId})`)
    return NextResponse.json({
      success: true,
      enabled,
      message: `Wallet & upgrade payment protection is now ${enabled ? "ON" : "OFF"}`,
    })
  } catch (e) {
    console.error("[WALLET-OTP-SETTINGS] POST error:", e)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
