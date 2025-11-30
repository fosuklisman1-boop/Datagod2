import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET() {
  try {
    const { data, error } = await supabase
      .from("support_settings")
      .select("*")
      .limit(1)
      .single()

    if (error && error.code !== "PGRST116") {
      console.error("Error fetching support settings:", error)
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      )
    }

    // If no data found, create default support_settings row
    if (!data) {
      const defaultSettings = {
        support_whatsapp: "233501234567",
        support_email: "support@datagod.com",
        support_phone: "0501234567"
      }

      const { data: newSettings, error: insertError } = await supabase
        .from("support_settings")
        .insert([defaultSettings])
        .select()
        .single()

      if (insertError) {
        console.error("Error creating support_settings:", insertError)
        // Return default if creation fails
        return NextResponse.json({
          success: true,
          data: defaultSettings
        })
      }

      return NextResponse.json({
        success: true,
        data: newSettings
      })
    }

    return NextResponse.json({
      success: true,
      data
    })
  } catch (error: any) {
    console.error("Error in GET /api/support-settings:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
