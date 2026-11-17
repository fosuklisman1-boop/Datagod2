import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { SHOP_MEMORY_SETTING_KEY as KEY } from "@/lib/shop-commerce/customer-prefs"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { data } = await supabase
      .from("admin_settings")
      .select("value, updated_at")
      .eq("key", KEY)
      .maybeSingle()

    return NextResponse.json({
      success: true,
      enabled: data?.value?.enabled === true,
      updated_at: data?.updated_at ?? null,
    })
  } catch (error) {
    console.error("[USSD Shop Memory] GET error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { enabled } = await request.json()
    if (typeof enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 })
    }

    const { error } = await supabase
      .from("admin_settings")
      .upsert(
        { key: KEY, value: { enabled }, description: "Offer the caller's remembered shop as option 1 on the shop USSD code screens" },
        { onConflict: "key" }
      )

    if (error) {
      console.error("[USSD Shop Memory] upsert error:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      enabled,
      message: `USSD shop memory is now ${enabled ? "ENABLED" : "DISABLED"}`,
    })
  } catch (error) {
    console.error("[USSD Shop Memory] POST error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
