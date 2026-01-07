import { NextRequest, NextResponse } from "next/server"
import { isAutoFulfillmentEnabled, setAutoFulfillmentEnabled } from "@/lib/mtn-fulfillment"
import { supabase } from "@/lib/supabase"

/**
 * GET /api/admin/settings/mtn-auto-fulfillment
 * Returns current MTN auto-fulfillment setting
 */
export async function GET(request: NextRequest) {
  try {
    // Verify admin access
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const { data: user, error: userError } = await supabase.auth.getUser(token)

    if (userError || !user?.user?.id) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 })
    }

    // Check if user is admin
    const { data: userData, error: userTableError } = await supabase
      .from("users")
      .select("role")
      .eq("id", user.user.id)
      .single()

    // Also check user_metadata for admin role
    const isAdminFromMetadata = user.user.user_metadata?.role === "admin"
    const isAdminFromTable = userData?.role === "admin"

    if (!isAdminFromMetadata && !isAdminFromTable) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 })
    }

    // Get setting
    const { data, error } = await supabase
      .from("admin_settings")
      .select("key, value, updated_at")
      .eq("key", "mtn_auto_fulfillment_enabled")
      .single()

    if (error) {
      return NextResponse.json(
        { error: "Setting not found" },
        { status: 404 }
      )
    }

    // Extract enabled value from JSON object
    const enabled = data.value?.enabled === true

    return NextResponse.json({
      success: true,
      enabled,
      updated_at: data.updated_at,
    })
  } catch (error) {
    console.error("[MTN] GET settings error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}

/**
 * POST /api/admin/settings/mtn-auto-fulfillment
 * Update MTN auto-fulfillment setting
 */
export async function POST(request: NextRequest) {
  try {
    // Verify admin access
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const { data: user, error: userError } = await supabase.auth.getUser(token)

    if (userError || !user?.user?.id) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 })
    }

    // Check if user is admin
    const { data: userData, error: userTableError } = await supabase
      .from("users")
      .select("role")
      .eq("id", user.user.id)
      .single()

    // Also check user_metadata for admin role
    const isAdminFromMetadata = user.user.user_metadata?.role === "admin"
    const isAdminFromTable = userData?.role === "admin"

    if (!isAdminFromMetadata && !isAdminFromTable) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 })
    }

    // Parse request body
    const body = await request.json()
    const { enabled } = body

    if (typeof enabled !== "boolean") {
      return NextResponse.json(
        { error: "enabled must be a boolean" },
        { status: 400 }
      )
    }

    // Update setting
    const success = await setAutoFulfillmentEnabled(enabled)

    if (!success) {
      return NextResponse.json(
        { error: "Failed to update setting" },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      enabled,
      message: `MTN auto-fulfillment is now ${enabled ? "ENABLED" : "DISABLED"}`,
    })
  } catch (error) {
    console.error("[MTN] POST settings error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
