import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { verifyAdminAccess } from "@/lib/admin-auth"

const KEY = "ussd_data_whitelist_enabled"

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
    console.error("[USSD Whitelist] GET error:", error)
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
        { key: KEY, value: { enabled }, description: "Restrict USSD data bundle purchases to registered users only" },
        { onConflict: "key" }
      )

    if (error) {
      console.error("[USSD Whitelist] upsert error:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      enabled,
      message: `USSD data whitelist is now ${enabled ? "ENABLED" : "DISABLED"}`,
    })
  } catch (error) {
    console.error("[USSD Whitelist] POST error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
