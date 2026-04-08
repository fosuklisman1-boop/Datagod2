import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// GET Christmas theme setting
export async function GET() {
  try {
    const { data: settings, error } = await supabase
      .from("app_settings")
      .select("christmas_theme_enabled")
      .single()

    if (error && error.code !== "PGRST116") {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }

    return NextResponse.json({
      christmas_theme_enabled: settings?.christmas_theme_enabled ?? false,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}

// UPDATE Christmas theme setting
export async function PUT(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const body = await request.json()
    const { christmas_theme_enabled } = body

    // Update or create settings
    const { error: updateError } = await supabase
      .from("app_settings")
      .update({ christmas_theme_enabled })
      .not("id", "is", null)

    if (updateError) {
      console.error("Error updating app_settings:", updateError)
      return NextResponse.json(
        { error: "Failed to update settings" },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      christmas_theme_enabled,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
