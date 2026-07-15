import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { PREFIX_TOGGLE_KEY } from "@/lib/network-prefix-config"

/**
 * GET /api/admin/settings/network-prefix-validation
 * Returns current network-prefix validation toggle (defaults ON).
 */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    // Get setting
    const { data, error } = await supabase
      .from("admin_settings")
      .select("key, value, updated_at")
      .eq("key", PREFIX_TOGGLE_KEY)
      .maybeSingle()

    if (error) {
      console.error("[PREFIX-VALIDATION] Error reading setting:", error)
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      )
    }

    // If setting doesn't exist, create it with default value (this feature defaults ON)
    if (!data) {
      const { data: newData, error: insertError } = await supabase
        .from("admin_settings")
        .insert({
          key: PREFIX_TOGGLE_KEY,
          value: { enabled: true },
          description: "Order-time network-prefix validation (hard block on mismatch)",
        })
        .select()
        .single()

      if (insertError) {
        console.error("[PREFIX-VALIDATION] Error creating setting:", insertError)
        return NextResponse.json(
          { error: insertError.message },
          { status: 500 }
        )
      }

      return NextResponse.json({
        success: true,
        enabled: true,
        updated_at: newData.updated_at,
      })
    }

    // Extract enabled value from JSON object — default-ON: only explicit false disables.
    const enabled = data.value?.enabled !== false

    return NextResponse.json({
      success: true,
      enabled,
      updated_at: data.updated_at,
    })
  } catch (error) {
    console.error("[PREFIX-VALIDATION] GET settings error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}

/**
 * POST /api/admin/settings/network-prefix-validation
 * Update network-prefix validation toggle.
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
    const { error } = await supabase
      .from("admin_settings")
      .upsert(
        {
          key: PREFIX_TOGGLE_KEY,
          value: { enabled },
          description: "Order-time network-prefix validation (hard block on mismatch)",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }
      )

    if (error) {
      console.error("[PREFIX-VALIDATION] Error updating setting:", error)
      return NextResponse.json(
        { error: "Failed to update setting" },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      enabled,
      message: `Network prefix validation is now ${enabled ? "ENABLED" : "DISABLED"}`,
    })
  } catch (error) {
    console.error("[PREFIX-VALIDATION] POST settings error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
