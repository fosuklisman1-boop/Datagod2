import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// GET shop settings
export async function GET(request: NextRequest, { params }: { params: Promise<{ shopId: string }> }) {
  try {
    const { shopId } = await params

    const { data: settings, error } = await supabase
      .from("shop_settings")
      .select("id, shop_name, description, is_active, user_id, created_at")
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
export async function PUT(request: NextRequest, { params }: { params: Promise<{ shopId: string }> }) {
  try {
    const { shopId } = await params
    console.log(`[SHOP-SETTINGS] PUT request for shop ${shopId}`)

    // Verify user is authenticated
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      console.log("[SHOP-SETTINGS] Missing authorization header")
      return NextResponse.json(
        { error: "No authorization token" },
        { status: 401 }
      )
    }

    const token = authHeader.split(" ")[1]

    // Verify user owns the shop
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)

    if (userError || !user) {
      console.log("[SHOP-SETTINGS] Invalid token:", userError)
      return NextResponse.json(
        { error: "Invalid token" },
        { status: 401 }
      )
    }

    console.log(`[SHOP-SETTINGS] User ${user.id} updating shop ${shopId}`)

    // Check if user owns this shop
    const { data: shopData, error: shopError } = await supabase
      .from("user_shops")
      .select("user_id")
      .eq("id", shopId)
      .single()

    if (shopError) {
      console.log("[SHOP-SETTINGS] Shop lookup error:", shopError)
    }

    if (!shopData || shopData.user_id !== user.id) {
      console.log(`[SHOP-SETTINGS] Permission denied. Shop owner: ${shopData?.user_id}, User: ${user.id}`)
      return NextResponse.json(
        { error: "You don't have permission to update this shop" },
        { status: 403 }
      )
    }

    const body = await request.json()
    const { whatsapp_link } = body

    console.log(`[SHOP-SETTINGS] Received whatsapp_link: ${whatsapp_link}`)

    if (!whatsapp_link || whatsapp_link.trim() === "") {
      console.log("[SHOP-SETTINGS] Empty whatsapp_link")
      return NextResponse.json(
        { error: "whatsapp_link is required" },
        { status: 400 }
      )
    }

    // Accept any format for WhatsApp link (phone number, URL, etc.)
    console.log("[SHOP-SETTINGS] WhatsApp link validated (any format accepted)")

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
