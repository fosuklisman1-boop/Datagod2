import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { shopHandleOrFilter } from "@/lib/shop-handle"
import { normalizeWhatsAppLink } from "@/lib/whatsapp-link"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// GET shop settings — param accepts a shop UUID (dashboard) or a public
// slug/subdomain (storefront, which no longer sees internal shop ids).
export async function GET(request: NextRequest, { params }: { params: Promise<{ shopId: string }> }) {
  try {
    let { shopId } = await params

    if (!UUID_RE.test(shopId)) {
      const { data: shopRow } = await supabase
        .from("user_shops")
        .select("id")
        .or(shopHandleOrFilter(shopId))
        .single()
      if (!shopRow) {
        return NextResponse.json({ error: "Shop not found" }, { status: 404 })
      }
      shopId = shopRow.id
    }

    const { data: settings, error } = await supabase
      .from("shop_settings")
      .select("id, shop_id, whatsapp_link, announcement_enabled, announcement_title, announcement_message, order_confirmation_sms_enabled, created_at, updated_at")
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
        announcement_enabled: false,
        announcement_title: "",
        announcement_message: "",
        // No row yet == never explicitly turned off, so this stays true.
        order_confirmation_sms_enabled: true,
        created_at: null,
        updated_at: null,
      })
    }

    // A row can predate this column (NULL) -- treat that the same as "never
    // explicitly turned off" rather than surfacing NULL to the UI.
    if (settings.order_confirmation_sms_enabled === null) {
      settings.order_confirmation_sms_enabled = true
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
    const {
      whatsapp_link,
      announcement_enabled,
      announcement_title,
      announcement_message,
      order_confirmation_sms_enabled
    } = body

    if (order_confirmation_sms_enabled !== undefined && typeof order_confirmation_sms_enabled !== "boolean") {
      return NextResponse.json({ error: "order_confirmation_sms_enabled must be a boolean" }, { status: 400 })
    }

    console.log(`[SHOP-SETTINGS] Received whatsapp_link: ${whatsapp_link}`)

    if (whatsapp_link !== undefined && whatsapp_link !== null && whatsapp_link !== "") {
      if (typeof whatsapp_link !== "string") {
        return NextResponse.json({ error: "whatsapp_link must be a string" }, { status: 400 })
      }
      if (whatsapp_link.length > 500) {
        return NextResponse.json({ error: "whatsapp_link must be 500 characters or fewer" }, { status: 400 })
      }
      // Accept URLs or phone numbers (digits with optional + prefix)
      const isUrl = /^https?:\/\//i.test(whatsapp_link)
      const isPhone = /^\+?[0-9]{7,15}$/.test(whatsapp_link.replace(/\s/g, ""))
      if (!isUrl && !isPhone) {
        return NextResponse.json({ error: "whatsapp_link must be a valid URL or phone number" }, { status: 400 })
      }
    }

    // Store a normalized, always-absolute URL — a bare phone number or a
    // malformed scheme (e.g. "0598781315", "https.wa.me 0249489229") saved
    // as-is would later be rendered as an <a href>, get resolved by the
    // browser as a RELATIVE path under the storefront's own /shop/[slug]
    // route, and break as "shop not found" (confirmed live on ~half of all
    // shops before this fix — see lib/whatsapp-link.ts).
    const normalizedWhatsappLink =
      whatsapp_link !== undefined && whatsapp_link !== null
        ? normalizeWhatsAppLink(whatsapp_link) ?? ""
        : whatsapp_link

    if (announcement_title !== undefined && typeof announcement_title === "string" && announcement_title.length > 200) {
      return NextResponse.json({ error: "announcement_title must be 200 characters or fewer" }, { status: 400 })
    }

    if (announcement_message !== undefined && typeof announcement_message === "string" && announcement_message.length > 2000) {
      return NextResponse.json({ error: "announcement_message must be 2000 characters or fewer" }, { status: 400 })
    }

    // Get existing settings
    const { data: existingSettings } = await supabase
      .from("shop_settings")
      .select("*")
      .eq("shop_id", shopId)
      .single()

    let result

    if (existingSettings) {
      // Update existing
      const { data, error } = await supabase
        .from("shop_settings")
        .update({
          whatsapp_link: whatsapp_link !== undefined ? normalizedWhatsappLink : existingSettings?.whatsapp_link,
          announcement_enabled: announcement_enabled !== undefined ? announcement_enabled : existingSettings?.announcement_enabled,
          announcement_title: announcement_title !== undefined ? announcement_title : existingSettings?.announcement_title,
          announcement_message: announcement_message !== undefined ? announcement_message : existingSettings?.announcement_message,
          order_confirmation_sms_enabled: order_confirmation_sms_enabled !== undefined ? order_confirmation_sms_enabled : existingSettings?.order_confirmation_sms_enabled,
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
            whatsapp_link: normalizedWhatsappLink || "",
            announcement_enabled: announcement_enabled || false,
            announcement_title: announcement_title || "",
            announcement_message: announcement_message || "",
            order_confirmation_sms_enabled: order_confirmation_sms_enabled !== undefined ? order_confirmation_sms_enabled : true,
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
