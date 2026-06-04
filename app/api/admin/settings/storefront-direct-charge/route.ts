import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { invalidateStorefrontDirectChargeCache } from "@/lib/storefront-otp"

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
    const { data, error } = await supabase
      .from("admin_settings")
      .select("key, value, updated_at")
      .eq("key", "storefront_direct_charge")
      .maybeSingle()

    if (error) {
      console.error("[STOREFRONT-DIRECT-CHARGE-SETTINGS] Read error:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      enabled: data?.value?.enabled === true,
      updated_at: data?.updated_at ?? null,
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

    const { error } = await supabase
      .from("admin_settings")
      .upsert({
        key: "storefront_direct_charge",
        value: { enabled },
        description: "Collect storefront shop-order payments via an on-page direct MoMo charge (live prompt modal) instead of the hosted Paystack redirect. Independent of the storefront OTP gate.",
        updated_at: new Date().toISOString(),
      }, { onConflict: "key" })

    if (error) {
      console.error("[STOREFRONT-DIRECT-CHARGE-SETTINGS] Upsert error:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    invalidateStorefrontDirectChargeCache()
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
