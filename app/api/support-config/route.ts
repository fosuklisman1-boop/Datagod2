import { createClient } from "@supabase/supabase-js"
import { NextResponse } from "next/server"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function GET() {
  try {
    const supabaseClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })

    // Fetch support settings from support_settings table
    const { data: settings, error } = await supabaseClient
      .from("support_settings")
      .select("support_email, support_phone, support_whatsapp, guest_purchase_url, guest_purchase_button_text")
      .limit(1)
      .single()

    console.log("[SUPPORT-CONFIG] Fetched settings:", { settings, error })

    if (error && error.code !== "PGRST116") {
      // PGRST116 is "no rows found" error
      console.error("[SUPPORT-CONFIG] Error fetching support settings:", error)
      // Still return defaults on error instead of 500
      return NextResponse.json({
        email: "support@datagod.com",
        phone: "+233 XXX XXX XXXX",
        whatsapp: "https://wa.me/233XXXXXXXXX",
        website: "https://www.datagod.store",
      })
    }

    // If no settings found, return defaults
    if (!settings) {
      console.log("[SUPPORT-CONFIG] No settings found, using defaults")
      return NextResponse.json({
        email: "support@datagod.com",
        phone: "+233 XXX XXX XXXX",
        whatsapp: "https://wa.me/233XXXXXXXXX",
        website: "https://datagod.com",
      })
    }

    console.log("[SUPPORT-CONFIG] Using database settings:", settings)

    // Format WhatsApp URL if it's just the number
    let whatsappUrl = settings.support_whatsapp || "https://wa.me/233XXXXXXXXX"
    if (whatsappUrl && !whatsappUrl.startsWith("http")) {
      whatsappUrl = `https://wa.me/${whatsappUrl}`
    }

    return NextResponse.json({
      email: settings.support_email || "support@datagod.com",
      phone: settings.support_phone || "+233 XXX XXX XXXX",
      whatsapp: whatsappUrl,
      website: "https://datagod.com",
      guestPurchaseUrl: settings.guest_purchase_url || null,
      guestPurchaseButtonText: settings.guest_purchase_button_text || 'Buy as Guest',
    })
  } catch (error: any) {
    console.error("API error:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
