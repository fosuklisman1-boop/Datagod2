import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { invalidateStorefrontOtpCache } from "@/lib/storefront-otp"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * GET /api/admin/settings/storefront-otp → current state (default off)
 */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { data, error } = await supabase
      .from("admin_settings")
      .select("key, value, updated_at")
      .eq("key", "storefront_otp_required")
      .maybeSingle()

    if (error) {
      console.error("[STOREFRONT-OTP-SETTINGS] Read error:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      enabled: data?.value?.enabled === true,
      updated_at: data?.updated_at ?? null,
    })
  } catch (e) {
    console.error("[STOREFRONT-OTP-SETTINGS] GET error:", e)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

/**
 * POST /api/admin/settings/storefront-otp  { enabled: boolean }
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
        key: "storefront_otp_required",
        value: { enabled },
        description: "Require SMS phone-OTP verification before a guest can place a shop order. Anti card-testing / payment-prompt-abuse lever — enable during attacks.",
        updated_at: new Date().toISOString(),
      }, { onConflict: "key" })

    if (error) {
      console.error("[STOREFRONT-OTP-SETTINGS] Upsert error:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    invalidateStorefrontOtpCache()
    console.warn(`[STOREFRONT-OTP-SETTINGS] ⚠️ Checkout OTP gate is now ${enabled ? "ENABLED" : "DISABLED"} (by ${userEmail ?? userId})`)
    return NextResponse.json({
      success: true,
      enabled,
      message: `Checkout phone-OTP is now ${enabled ? "REQUIRED" : "OFF"}`,
    })
  } catch (e) {
    console.error("[STOREFRONT-OTP-SETTINGS] POST error:", e)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
