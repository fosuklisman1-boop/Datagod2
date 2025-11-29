import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// GET settings
export async function GET(request: NextRequest) {
  try {
    const { data: settings, error } = await supabase
      .from("app_settings")
      .select("*")
      .single()

    if (error && error.code !== "PGRST116") {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }

    // Return default settings if none exist
    if (!settings) {
      return NextResponse.json({
        id: null,
        join_community_link: "",
        created_at: null,
        updated_at: null,
      })
    }

    return NextResponse.json(settings)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}

// UPDATE settings
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

    // Check if user is admin
    const { data: adminData } = await supabase
      .from("admins")
      .select("id")
      .eq("user_id", user.id)
      .single()

    if (!adminData) {
      return NextResponse.json(
        { error: "User is not an admin" },
        { status: 403 }
      )
    }

    const body = await request.json()
    const { join_community_link } = body

    if (!join_community_link) {
      return NextResponse.json(
        { error: "join_community_link is required" },
        { status: 400 }
      )
    }

    // Validate URL format
    try {
      new URL(join_community_link)
    } catch {
      return NextResponse.json(
        { error: "Invalid URL format" },
        { status: 400 }
      )
    }

    // Get existing settings
    const { data: existingSettings } = await supabase
      .from("app_settings")
      .select("id")
      .single()

    let result

    if (existingSettings) {
      // Update existing
      const { data, error } = await supabase
        .from("app_settings")
        .update({
          join_community_link,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingSettings.id)
        .select()
        .single()

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 400 })
      }

      result = data
    } else {
      // Create new
      const { data, error } = await supabase
        .from("app_settings")
        .insert([
          {
            join_community_link,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ])
        .select()
        .single()

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 400 })
      }

      result = data
    }

    return NextResponse.json({
      success: true,
      settings: result,
    })
  } catch (error) {
    console.error("[SETTINGS-API] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
