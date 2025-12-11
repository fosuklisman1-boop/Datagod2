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

    // Fetch support settings from admin_settings table
    const { data: settings, error } = await supabaseClient
      .from("admin_settings")
      .select("*")
      .eq("setting_key", "support_contact")
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
        website: "https://datagod.com",
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
    const settingValue = settings.setting_value || {}

    return NextResponse.json({
      email: settingValue.email || "support@datagod.com",
      phone: settingValue.phone || "+233 XXX XXX XXXX",
      whatsapp: settingValue.whatsapp || "https://wa.me/233XXXXXXXXX",
      website: settingValue.website || "https://datagod.com",
    })
  } catch (error: any) {
    console.error("API error:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
