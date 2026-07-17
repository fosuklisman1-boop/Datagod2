import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const SETTING_KEY = "mtn_whitelist_enabled"
const DEFAULT_VALUE = { enabled: true }

export async function GET(request: NextRequest) {
  try {
    const { data, error } = await supabase
      .from("admin_settings")
      .select("value, updated_at, updated_by")
      .eq("key", SETTING_KEY)
      .single()

    if (error) {
      if (error.code === "PGRST116") {
        return NextResponse.json({ success: true, setting: DEFAULT_VALUE, isDefault: true })
      }
      throw error
    }

    return NextResponse.json({ success: true, setting: data.value, updatedAt: data.updated_at })
  } catch (error) {
    console.error("[MTN-WHITELIST-SETTING] GET error:", error)
    return NextResponse.json({ error: "Failed to fetch setting" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const { enabled } = await request.json()
    if (typeof enabled !== "boolean") {
      return NextResponse.json({ error: "'enabled' must be a boolean" }, { status: 400 })
    }

    const newValue = { enabled }
    await supabase.from("admin_settings").upsert(
      {
        key: SETTING_KEY,
        value: newValue,
        description: "When enabled, MTN orders are checked against all configured whitelist providers (Xpress, Codecraft, …) before fulfillment. Blocked numbers are held and retried every 24h for up to 72h.",
        updated_at: new Date().toISOString(),
        updated_by: adminId,
      },
      { onConflict: "key" }
    )

    console.log(`[MTN-WHITELIST-SETTING] set enabled=${enabled} by admin ${adminId}`)
    return NextResponse.json({
      success: true,
      setting: newValue,
      message: enabled
        ? "MTN whitelist verification enabled. Orders will be checked against Xpress/Codecraft before fulfillment."
        : "MTN whitelist verification disabled. Orders will skip the whitelist check.",
    })
  } catch (error) {
    console.error("[MTN-WHITELIST-SETTING] POST error:", error)
    return NextResponse.json({ error: "Failed to update setting" }, { status: 500 })
  }
}
