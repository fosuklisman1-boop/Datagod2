import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

const SETTING_KEY = "afa_auto_fulfillment_enabled"

/**
 * GET /api/admin/settings/afa-auto-fulfillment
 * Returns current AFA auto-fulfillment toggle state.
 */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const { data, error } = await supabase
    .from("admin_settings")
    .select("value, updated_at")
    .eq("key", SETTING_KEY)
    .maybeSingle()

  if (error) {
    console.error("[AFA-SETTING] Read error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!data) {
    // Create default (disabled)
    const { data: created, error: insertError } = await supabase
      .from("admin_settings")
      .insert({
        key: SETTING_KEY,
        value: { enabled: false },
        description:
          "Controls whether AFA orders are auto-submitted to Sykes API on placement",
      })
      .select()
      .single()

    if (insertError) {
      console.error("[AFA-SETTING] Insert error:", insertError)
      return NextResponse.json({ error: insertError.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, enabled: false, updated_at: created.updated_at })
  }

  return NextResponse.json({
    success: true,
    enabled: data.value?.enabled === true,
    updated_at: data.updated_at,
  })
}

/**
 * POST /api/admin/settings/afa-auto-fulfillment
 * Body: { enabled: boolean }
 */
export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const body = await request.json()
  const { enabled } = body

  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "'enabled' must be a boolean" }, { status: 400 })
  }

  const { data, error } = await supabase
    .from("admin_settings")
    .upsert(
      {
        key: SETTING_KEY,
        value: { enabled },
        description:
          "Controls whether AFA orders are auto-submitted to Sykes API on placement",
        updated_at: new Date().toISOString(),
        updated_by: userId,
      },
      { onConflict: "key" }
    )
    .select()
    .single()

  if (error) {
    console.error("[AFA-SETTING] Upsert error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  console.log(`[AFA-SETTING] Updated by ${userId}: enabled=${enabled}`)

  return NextResponse.json({
    success: true,
    enabled,
    updated_at: data.updated_at,
    message: enabled
      ? "AFA auto-fulfillment ENABLED — new orders will be sent to Sykes automatically."
      : "AFA auto-fulfillment DISABLED — orders will wait for manual fulfillment.",
  })
}
