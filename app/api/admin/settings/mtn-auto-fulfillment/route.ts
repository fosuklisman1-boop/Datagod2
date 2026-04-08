import { NextRequest, NextResponse } from "next/server"
import { isAutoFulfillmentEnabled, setAutoFulfillmentEnabled } from "@/lib/mtn-fulfillment"
import { supabase } from "@/lib/supabase"
import { verifyAdminAccess } from "@/lib/admin-auth"

/**
 * GET /api/admin/settings/mtn-auto-fulfillment
 * Returns current MTN auto-fulfillment setting
 */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    // Get setting
    const { data, error } = await supabase
      .from("admin_settings")
      .select("key, value, updated_at")
      .eq("key", "mtn_auto_fulfillment_enabled")
      .maybeSingle()

    if (error) {
      console.error("[MTN] Error reading setting:", error)
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
          key: "mtn_auto_fulfillment_enabled",
          value: { enabled: false },
          description: "Controls whether MTN orders are auto-fulfilled via MTN API or sent to admin queue",
        })
        .select()
        .single()

      if (insertError) {
        console.error("[MTN] Error creating setting:", insertError)
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
