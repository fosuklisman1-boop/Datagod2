import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

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
  try {
    // Verify admin authorization
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "No authorization token" },
        { status: 401 }
      )
    }

    const token = authHeader.split(" ")[1]

    // Verify user is admin
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)

    if (userError || !user) {
      return NextResponse.json(
        { error: "Invalid token" },
        { status: 401 }
      )
    }

    // Check if user is admin via user_metadata
    const role = user.user_metadata?.role
    if (role !== "admin") {
      return NextResponse.json(
        { error: "User is not an admin" },
        { status: 403 }
      )
    }

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
