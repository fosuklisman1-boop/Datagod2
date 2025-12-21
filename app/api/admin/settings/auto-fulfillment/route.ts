import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

const SETTING_KEY = "auto_fulfillment_enabled"
const DEFAULT_VALUE = { enabled: true, networks: ["AT - iShare", "Telecel"] }

/**
 * GET - Retrieve auto-fulfillment setting
 */
export async function GET(request: NextRequest) {
  try {
    const { data, error } = await supabase
      .from("admin_settings")
      .select("value, updated_at, updated_by")
      .eq("key", SETTING_KEY)
      .single()

    if (error) {
      // If setting doesn't exist, return default
      if (error.code === "PGRST116") {
        return NextResponse.json({
          success: true,
          setting: DEFAULT_VALUE,
          isDefault: true
        })
      }
      throw error
    }

    return NextResponse.json({
      success: true,
      setting: data.value,
      updatedAt: data.updated_at,
      updatedBy: data.updated_by,
      isDefault: false
    })
  } catch (error) {
    console.error("[AUTO-FULFILLMENT] Error fetching setting:", error)
    return NextResponse.json(
      { error: "Failed to fetch setting", details: String(error) },
      { status: 500 }
    )
  }
}

/**
 * POST - Update auto-fulfillment setting
 */
export async function POST(request: NextRequest) {
  try {
    // Verify admin authentication
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 })
    }

    // Check if user is admin
    if (user.user_metadata?.role !== "admin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 })
    }

    const { enabled } = await request.json()

    if (typeof enabled !== "boolean") {
      return NextResponse.json(
        { error: "Invalid request: 'enabled' must be a boolean" },
        { status: 400 }
      )
    }

    const newValue = {
      enabled,
      networks: ["AT - iShare", "Telecel"]
    }

    // Upsert the setting
    const { data, error } = await supabase
      .from("admin_settings")
      .upsert(
        {
          key: SETTING_KEY,
          value: newValue,
          description: "Controls whether AT-iShare and Telecel orders are auto-fulfilled via Code Craft API or sent to admin queue",
          updated_at: new Date().toISOString(),
          updated_by: user.id
        },
        { onConflict: "key" }
      )
      .select()
      .single()

    if (error) {
      throw error
    }

    console.log(`[AUTO-FULFILLMENT] Setting updated by admin ${user.id}: enabled=${enabled}`)

    return NextResponse.json({
      success: true,
      setting: newValue,
      message: enabled
        ? "Auto-fulfillment enabled. AT-iShare and Telecel orders will be fulfilled automatically."
        : "Auto-fulfillment disabled. AT-iShare and Telecel orders will go to admin queue."
    })
  } catch (error) {
    console.error("[AUTO-FULFILLMENT] Error updating setting:", error)
    return NextResponse.json(
      { error: "Failed to update setting", details: String(error) },
      { status: 500 }
    )
  }
}
