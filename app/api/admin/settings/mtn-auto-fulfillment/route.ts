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
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.user.id)
      .single()

    if (profileError || profile?.role !== "admin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 })
    }

    // Get setting
    const { data, error } = await supabase
      .from("app_settings")
      .select("key, value, updated_at")
      .eq("key", "mtn_auto_fulfillment_enabled")
      .single()

    if (error) {
      return NextResponse.json(
        { error: "Setting not found" },
        { status: 404 }
      )
    }

    return NextResponse.json({
      success: true,
      enabled: data.value === "true",
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
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.user.id)
      .single()

    if (profileError || profile?.role !== "admin") {
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
