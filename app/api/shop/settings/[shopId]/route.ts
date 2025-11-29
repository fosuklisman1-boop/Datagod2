import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// GET shop settings
export async function GET(request: NextRequest, { params }: { params: { shopId: string } }) {
  try {
    const { shopId } = params

    const { data: settings, error } = await supabase
      .from("shop_settings")
      .select("*")
      .eq("shop_id", shopId)
      .single()

    if (error && error.code !== "PGRST116") {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }

    if (!settings) {
      return NextResponse.json({
        id: null,
        shop_id: shopId,
        whatsapp_link: "",
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

// UPDATE shop settings
export async function PUT(request: NextRequest, { params }: { params: { shopId: string } }) {
  try {
    const { shopId } = params

    // Verify user is authenticated
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "No authorization token" },
        { status: 401 }
      )
    }

    const token = authHeader.split(" ")[1]

    // Verify user owns the shop
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)

    if (userError || !user) {
      return NextResponse.json(
        { error: "Invalid token" },
        { status: 401 }
      )
    }

    // Check if user owns this shop
    const { data: shopData } = await supabase
      .from("shops")
      .select("user_id")
      .eq("id", shopId)
      .single()

    if (!shopData || shopData.user_id !== user.id) {
      return NextResponse.json(
        { error: "You don't have permission to update this shop" },
        { status: 403 }
      )
    }

    const body = await request.json()
    const { whatsapp_link } = body

    if (!whatsapp_link) {
      return NextResponse.json(
        { error: "whatsapp_link is required" },
        { status: 400 }
      )
    }

    // Validate URL format
    try {
      new URL(whatsapp_link)
    } catch {
      return NextResponse.json(
        { error: "Invalid URL format" },
        { status: 400 }
      )
    }

    // Get existing settings
    const { data: existingSettings } = await supabase
      .from("shop_settings")
      .select("id")
      .eq("shop_id", shopId)
      .single()

    let result

    if (existingSettings) {
      // Update existing
      const { data, error } = await supabase
        .from("shop_settings")
        .update({
          whatsapp_link,
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
        .from("shop_settings")
        .insert([
          {
            shop_id: shopId,
            whatsapp_link,
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
    console.error("[SHOP-SETTINGS-API] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
