import { NextRequest, NextResponse } from "next/server"
import { isRegistrationGateEnabled, setRegistrationGateEnabled } from "@/lib/mtn-fulfillment"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { verifyAdminAccess } from "@/lib/admin-auth"

/**
 * GET /api/admin/settings/mtn-registration-gate
 * Returns current MTN registration gate setting
 */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    // Get setting
    const { data, error } = await supabase
      .from("admin_settings")
      .select("key, value, updated_at")
      .eq("key", "mtn_registration_gate_enabled")
      .maybeSingle()

    if (error) {
      console.error("[MTN-GATE] Error reading setting:", error)
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      )
    }

    // If setting doesn't exist, create it with default value
    if (!data) {
      const { data: newData, error: insertError } = await supabase
        .from("admin_settings")
        .insert({
          key: "mtn_registration_gate_enabled",
          value: { enabled: false },
          description: "Phase 2 MTN registration gate: hold orders for numbers not yet registered with MTN",
        })
        .select()
        .single()

      if (insertError) {
        console.error("[MTN-GATE] Error creating setting:", insertError)
        return NextResponse.json(
          { error: insertError.message },
          { status: 500 }
        )
      }

      return NextResponse.json({
        success: true,
        enabled: false,
        updated_at: newData.updated_at,
      })
    }

    // Extract enabled value from JSON object
    const enabled = data.value?.enabled === true

    return NextResponse.json({
      success: true,
      enabled,
      updated_at: data.updated_at,
    })
  } catch (error) {
    console.error("[MTN-GATE] GET settings error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}

/**
 * POST /api/admin/settings/mtn-registration-gate
 * Update MTN registration gate setting
 */
export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
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
    const success = await setRegistrationGateEnabled(enabled)

    if (!success) {
      return NextResponse.json(
        { error: "Failed to update setting" },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      enabled,
      message: `MTN registration gate is now ${enabled ? "ENABLED" : "DISABLED"}`,
    })
  } catch (error) {
    console.error("[MTN-GATE] POST settings error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
